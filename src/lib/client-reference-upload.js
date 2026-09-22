"use client";

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

function retryableUploadStatus(status) {
  return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Uploads through a newly-issued signed URL. A fresh URL is requested on each
 * retry because a failed/expired signature cannot be repaired by replaying the
 * same PUT. This also covers short Wi-Fi changes and transient GCS failures.
 */
export async function uploadFileDirect(file, purpose, { attempts = 3, fetchImpl = fetch } = {}) {
  const contentType = uploadContentType(file);
  if (!contentType) throw new Error(`Could not determine the file type for ${file?.name || "this file"}.`);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl("/api/uploads/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, contentType }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error || "Could not prepare the upload.");
        if (response.status < 500 && response.status !== 429) error.noRetry = true;
        if (error.noRetry) throw error;
        lastError = error;
        continue;
      }

      const uploaded = await fetchImpl(body.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
      });
      if (uploaded.ok) return { key: body.key, ref: `/api/media/${body.key}` };

      lastError = new Error(`Storage rejected the upload (${uploaded.status}).`);
      if (!retryableUploadStatus(uploaded.status)) lastError.noRetry = true;
      if (lastError.noRetry) throw lastError;
    } catch (error) {
      lastError = error;
      if (error?.noRetry) throw error;
      if (attempt === attempts) break;
    }
  }
  throw new Error(`${lastError?.message || "Upload failed."} Try uploading the file again.`);
}

export async function uploadOriginalReference(file) {
  return (await uploadFileDirect(file, "image-reference")).ref;
}
