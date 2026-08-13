/**
 * Sniff an image's real format from its own bytes.
 *
 * BUG-03 (found in the download-zip route): `extensionFromContentType(null,
 * item.url)` was called with `null` hardcoded as the content-type argument,
 * so every content-type branch was dead code and it always fell through to
 * guessing from the URL. Storage keys here are frequently extensionless
 * (UUIDs), so that guess silently produced ".bin" for a large share of
 * downloads. By the time this runs, `readStoredBuffer()` has already
 * returned the full buffer — the magic number is right there, no content-type
 * header ever needed to exist in the first place.
 *
 * Only formats this app actually writes to image storage are recognised
 * (see save-media.js / storage.js): PNG, JPEG, WebP, GIF, AVIF. Video is
 * deliberately out of scope — every call site filters to `kind === "image"`
 * before reaching this function.
 */
export function extensionFromBytes(bytes, fallbackUrl) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return "png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "jpg";
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // "WEBP"
  ) {
    return "webp";
  }
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    // "GIF8" — both GIF87a and GIF89a
    return "gif";
  }
  if (
    b.length >= 12 &&
    b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 // "ftyp" ISOBMFF box
  ) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "avif";
  }
  // Genuinely unrecognised bytes — fall back to the URL, same as before.
  const urlExt = fallbackUrl.split("?")[0].split(".").pop()?.toLowerCase();
  return urlExt && urlExt.length <= 5 ? urlExt : "bin";
}
