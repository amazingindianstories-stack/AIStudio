import { splitDataUrl } from "../../storage";

const EXT_TO_MIME = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** Converts user-attached reference image data URLs into Gemini inlineData
 *  parts. Reuses storage.ts's splitDataUrl for the same MIME allowlist every
 *  other upload path in this app already enforces (JPEG/PNG/WebP/GIF only —
 *  throws on SVG/anything else), rather than re-validating here. */
export function imagesToParts(dataUrls) {
  return dataUrls.map((url) => {
    const { ext, data } = splitDataUrl(url);
    return { inlineData: { mimeType: EXT_TO_MIME[ext], data } };
  });
}
