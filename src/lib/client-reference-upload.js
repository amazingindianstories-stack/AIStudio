"use client";

import { apiErrorMessage } from "./api-error";

const MIME_BY_EXTENSION = Object.freeze({
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic", heif: "image/heif",
  avif: "image/avif", bmp: "image/bmp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
});

export function uploadContentType(file) {
  const supplied = String(file?.type || "").trim().toLowerCase();
  if (["image/jpg", "image/pjpeg"].includes(supplied)) return "image/jpeg";
  if (supplied === "image/x-png") return "image/png";
  if (supplied) return supplied;
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  return MIME_BY_EXTENSION[extension] || "";
}

const CHUNK_BYTES = 8 * 1024 * 1024;

function uploadError(message, retryable = false, code = null) {
  const error = new Error(message);
  error.retryable = retryable;
  if (code) error.code = code;
  return error;
}

async function request(fetchImpl, url, options, signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Upload request timed out.")), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function offsetFromResponse(response, size) {
  // Chromium exposes native no-Location308 with redirect:error, while
  // refusing Location redirects before private bytes reach another authority.
  // Manual mode hides protocol Range headers behind an opaque response.
  if (response.redirected) throw uploadError("Storage unexpectedly redirected the resumable upload.");
  if (response.status === 200 || response.status === 201) return size;
  if (response.status !== 308) {
    if (response.status === 404 || response.status === 410) {
      const error = uploadError("The storage upload session expired. Retry the upload.");
      error.expired = true;
      throw error;
    }
    throw uploadError(`Storage rejected the upload (${response.status}).`,
      response.status === 408 || response.status === 429 || response.status >= 500);
  }
  const range = response.headers?.get("Range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw uploadError("Storage returned an invalid resumable byte range.");
  }
  return offset;
}

async function jsonRequest(fetchImpl, url, body, signal, timeoutMs) {
  const response = await request(fetchImpl, url, { method: "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, signal, timeoutMs);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw uploadError(apiErrorMessage(value, response.status, "Upload failed. Try again."),
    response.status === 408 || response.status === 429 || response.status >= 500,
    typeof value.code === "string" ? value.code : typeof value.error === "string" ? value.error : null);
  return value;
}

function abortCheck(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException("Upload cancelled.", "AbortError");
}

async function pause(milliseconds, signal) {
  abortCheck(signal);
  await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", aborted); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const aborted = () => { clearTimeout(timer); reject(signal.reason || new DOMException("Upload cancelled.", "AbortError")); };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Original bytes go directly to a native GCS session. API requests are metadata
 * only; session bearer URLs exist solely in this call's memory. Local fixture
 * storage implements the same Content-Range protocol with cookie authentication.
 */
export async function uploadFileDirect(file, purpose, {
  attempts = 3, fetchImpl = fetch, signal, onProgress, sha256,
  resumeUploadId,
  timeoutMs = 120000, metadataTimeoutMs = 30000, retryDelayMs = 250,
} = {}) {
  const contentType = uploadContentType(file);
  if (!contentType) throw new Error(`Could not determine the file type for ${file?.name || "this file"}.`);
  if (!Number.isSafeInteger(file?.size) || file.size <= 0 || typeof file.slice !== "function") {
    throw new Error("Choose a nonempty file to upload.");
  }
  const requestKey = globalThis.crypto?.randomUUID?.() || `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let session;
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  try {
    if (resumeUploadId) {
      const status = await request(fetchImpl, `/api/uploads/${encodeURIComponent(resumeUploadId)}/status`,
        { credentials: "same-origin" }, signal, metadataTimeoutMs);
      session = await status.json();
      if (!status.ok || session.byteSize !== file.size || session.contentType !== contentType || session.purpose !== purpose
        || (session.filename && session.filename !== String(file.name || "upload").slice(0, 255))) {
        throw uploadError(apiErrorMessage(session, status.status, "This file does not match the upload being resumed."));
      }
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (session) break;
      abortCheck(signal);
      try {
        session = await jsonRequest(fetchImpl, "/api/uploads/init", {
          version: 1, purpose, contentType, byteSize: file.size,
          filename: String(file.name || "upload").slice(0, 255), requestKey,
          ...(sha256 ? { sha256 } : {}),
        }, signal, metadataTimeoutMs);
        break;
      } catch (error) {
        if (signal?.aborted || error.retryable === false || attempt + 1 >= attempts) throw error;
        await pause(retryDelayMs * 2 ** attempt, signal);
      }
    }
    if (!session?.uploadId) throw new Error("Upload negotiation returned no session identity.");
    if (session.state === "ready") return session;
    if (!session.uploadUrl || !session.key) throw new Error("Upload negotiation returned an invalid storage session.");
    const url = session.uploadUrl;
    const local = url.startsWith("/api/uploads/");
    if (!local) {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || target.port
        || target.hash || !(target.hostname === "storage.googleapis.com"
          || /^[a-z0-9][a-z0-9.-]*\.storage\.googleapis\.com$/.test(target.hostname))) {
        throw new Error("Upload negotiation returned an unsafe storage URL.");
      }
    }
    let offset = 0;
    let failures = 0;
    let stagnant = 0;
    const chunkBytes = session.chunkBytes ?? CHUNK_BYTES;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > CHUNK_BYTES
      || chunkBytes % (256 * 1024) !== 0) throw new Error("Upload negotiation returned an invalid chunk size.");
    if (resumeUploadId) {
      const status = await request(fetchImpl, url, { method: "PUT", redirect: "error",
        credentials: local ? "same-origin" : "omit",
        headers: { "Content-Range": `bytes */${file.size}` }, body: new Blob([]),
      }, signal, timeoutMs);
      offset = offsetFromResponse(status, file.size);
    }
    while (offset < file.size) {
      abortCheck(signal);
      if (Date.now() > deadline) throw new Error("Upload exceeded its time limit. Retry the upload.");
      const end = Math.min(offset + chunkBytes, file.size);
      try {
        const response = await request(fetchImpl, url, { method: "PUT", redirect: "error",
          credentials: local ? "same-origin" : "omit",
          headers: { "Content-Type": contentType, "Content-Range": `bytes ${offset}-${end - 1}/${file.size}` },
          body: file.slice(offset, end),
        }, signal, timeoutMs);
        const next = offsetFromResponse(response, file.size);
        if (next < offset || next > end) throw uploadError("Storage acknowledged an unexpected upload offset.");
        stagnant = next === offset ? stagnant + 1 : 0;
        if (stagnant >= attempts) throw uploadError("Storage did not accept upload bytes. Retry the upload.");
        offset = next;
        failures = 0;
        onProgress?.({ uploadedBytes: offset, totalBytes: file.size, state: "uploading" });
      } catch (error) {
        abortCheck(signal);
        if (error.retryable === false || error.expired || ++failures >= attempts) throw error;
        await pause(retryDelayMs * 2 ** (failures - 1), signal);
        // A lost ACK may have committed bytes. Ask storage before replaying.
        try {
          const status = await request(fetchImpl, url, { method: "PUT", redirect: "error",
            credentials: local ? "same-origin" : "omit",
            headers: { "Content-Range": `bytes */${file.size}` }, body: new Blob([]),
          }, signal, timeoutMs);
          offset = offsetFromResponse(status, file.size);
          onProgress?.({ uploadedBytes: offset, totalBytes: file.size, state: "uploading" });
        } catch (statusError) {
          if (statusError.retryable === false || statusError.expired) throw statusError;
          // Retry remains on the same session. Never allocate another object for
          // a transient response whose bytes may already have been committed.
        }
      }
    }
    onProgress?.({ uploadedBytes: file.size, totalBytes: file.size, state: "verifying" });
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const ready = await jsonRequest(fetchImpl, `/api/uploads/${session.uploadId}/finalize`,
          { version: 1 }, signal, metadataTimeoutMs);
        if (ready.state !== "ready" || !ready.referenceId || !ready.ref) {
          throw uploadError("Upload verification did not return a reusable reference.");
        }
        onProgress?.({ uploadedBytes: file.size, totalBytes: file.size, state: "ready" });
        return ready;
      } catch (error) {
        abortCheck(signal);
        if (error.retryable === false || attempt + 1 >= attempts) throw error;
        await pause(retryDelayMs * 2 ** attempt, signal);
      }
    }
  } catch (error) {
    if (session?.uploadId && signal?.aborted) {
      // Cancellation is explicit; failures remain resumable, not destructive.
      await jsonRequest(fetchImpl, `/api/uploads/${session.uploadId}/cancel`,
        { version: 1 }, undefined, 5000).catch(() => {});
    }
    throw error;
  }
}

export async function uploadOriginalReference(file, options) {
  return (await uploadFileDirect(file, "image-reference", options)).ref;
}

export async function uploadVideoReference(file, options) {
  return uploadFileDirect(file, "video-reference", options);
}

export async function uploadAudioReference(file, options) {
  return uploadFileDirect(file, "audio-reference", options);
}
