"use client";

// Shared client-side reference-image encoding budget. Any path that turns an
// image into a data URL reference (file upload, paste/drop, or "use as
// reference" from an existing generation) must go through this ladder —
// Vercel's request body limit is 4.5MB and an ungated full-resolution
// generated image can be many times that, which surfaces as a non-JSON 413
// response (see store.ts's generate()).

/** Client reference longest-side cap. Identity tiles are cropped from these
 * refs server-side, so higher fidelity here carries real facial detail. */
export const REF_MAX_DIM = Number(process.env.NEXT_PUBLIC_REF_MAX_DIM) || 2048;

// Vercel body limit 4.5MB; base64 inflates ~1.33×, so the raw-bytes budget
// across all refs in a batch is ~3.38MB. Target 3.0MB to leave headroom for
// the prompt JSON.
export const REF_BATCH_BUDGET_BYTES = 3.0 * 1024 * 1024;

export const REF_BUDGET_STEPS: Array<{ dim: number; quality: number }> = [
  { dim: REF_MAX_DIM, quality: 0.85 },
  { dim: REF_MAX_DIM, quality: 0.7 },
  { dim: 1536, quality: 0.8 },
  { dim: 1024, quality: 0.8 },
];

/** Raw byte size of a data URL's base64 payload, ((len*3)/4). */
export function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return (b64.length * 3) / 4;
}

export function downscaleBlob(
  blob: Blob,
  maxDim: number,
  quality: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("No canvas context"));
      ctx.drawImage(img, 0, 0, width, height);
      // Export as JPEG to ensure small size (avoids massive PNGs)
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
}

/** Walk a single blob down the budget ladder until its encoded size fits
 * `budgetBytes`, falling back to the last (smallest) step if none fit. */
export async function encodeBlobWithBudget(
  blob: Blob,
  budgetBytes = REF_BATCH_BUDGET_BYTES
): Promise<string> {
  let dataUrl = "";
  for (let i = 0; i < REF_BUDGET_STEPS.length; i++) {
    const { dim, quality } = REF_BUDGET_STEPS[i];
    dataUrl = await downscaleBlob(blob, dim, quality);
    if (dataUrlBytes(dataUrl) <= budgetBytes || i === REF_BUDGET_STEPS.length - 1) {
      break;
    }
  }
  return dataUrl;
}
