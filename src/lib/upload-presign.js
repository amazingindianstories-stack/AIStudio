import { randomUUID } from "node:crypto";

export const UPLOAD_PURPOSES = Object.freeze({
  "image-reference": {
    prefix: "uploads/image-reference",
    contentTypes: /^image\/(jpeg|png|webp|tiff|gif|heic|heif|avif|bmp)$/,
  },
  "audio-reference": {
    prefix: "uploads/audio-reference",
    contentTypes: /^audio\/(mpeg|mp3|wav|x-wav|wave|ogg|webm|mp4|x-m4a|aac|flac)$/,
  },
  "depth-input": {
    prefix: "uploads/depth-input",
    contentTypes: /^video\//,
  },
});

export async function createUploadPresign(
  { userId, purpose, contentType },
  { signUploadUrl, createId = randomUUID }
) {
  if (!userId) {
    return { status: 401, body: { error: "Unauthorized." } };
  }

  const config = UPLOAD_PURPOSES[purpose];
  if (!config) {
    return {
      status: 400,
      body: { error: `Unknown upload purpose (expected one of: ${Object.keys(UPLOAD_PURPOSES).join(", ")}).` },
    };
  }

  const normalizedContentType = typeof contentType === "string"
    ? contentType.trim().toLowerCase()
        .replace(/^image\/(jpg|pjpeg)$/, "image/jpeg")
        .replace(/^image\/x-png$/, "image/png")
    : "";
  if (!config.contentTypes.test(normalizedContentType)) {
    return {
      status: 400,
      body: { error: `${purpose} does not accept content type "${typeof contentType === "string" ? contentType : ""}".` },
    };
  }

  const key = `${config.prefix}/${userId}-${createId()}`;
  try {
    const uploadUrl = await signUploadUrl(key, normalizedContentType);
    return { status: 200, body: { key, uploadUrl } };
  } catch (error) {
    console.error("[uploads/presign] signing failed", {
      purpose,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return { status: 500, body: { error: "Failed to create an upload URL." } };
  }
}
