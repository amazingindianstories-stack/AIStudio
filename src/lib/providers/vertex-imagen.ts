/**
 * DORMANT — Vertex AI imagen-3.0-capability-001 (Imagen 3 customization).
 *
 * Kept for reference, not imported anywhere. Judged probes (2026-07-03, Naisha
 * benchmark) showed its subject-reference face inpaint DEGRADES identity vs a
 * plain Nano Banana Pro frame (65→35 at 1K, 65→15 at 4K), and its hard limits
 * don't fit the product (max 4 reference images total — RAW/MASK count against
 * it — and only 2 for non-square aspect ratios; no 21:9; ~1K output).
 *
 * Schema notes that cost real debugging, for whoever revisits this:
 * - Multiple images of the SAME subject must share one `referenceId`.
 * - The prompt must cite refs as `[$referenceId]`; style refs need the
 *   "Create a STYLE_DESCRIPTION [N] image about …" template.
 * - `subjectType` nests inside `subjectImageConfig`; use SUBJECT_TYPE_DEFAULT
 *   for non-person refs (PERSON on a location ⇒ black frame).
 * - CONTROL_TYPE_FACE_MESH exists (one per request, auto-computed if omitted).
 */
import { GoogleAuth } from "google-auth-library";
import type { AssembledPrompt } from "../prompt-assembler";

const LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

export interface VertexImagenInput {
  assembled: AssembledPrompt;
  aspectRatio?: string; // 1:1 | 16:9 | 9:16 | 4:3 | 3:4 (no 21:9)
}

export interface VertexImagenResult {
  base64: string;
  mimeType: string;
}

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

export async function generateImageVertexImagen(
  input: VertexImagenInput
): Promise<VertexImagenResult> {
  let projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    try {
      projectId = await auth.getProjectId();
    } catch {
      throw new Error(
        "GCP Auth failed: Unable to detect a Project ID. Please set GOOGLE_CLOUD_PROJECT in your .env.local file."
      );
    }
  }

  const token = await auth.getAccessToken();
  if (!projectId || !token) {
    throw new Error(
      "GCP Auth failed. Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login."
    );
  }

  const model = "imagen-3.0-capability-001";
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${model}:predict`;

  const { instruction, groups } = input.assembled;

  // Each GROUP is one subject → ONE referenceId shared by all its images.
  const referenceImages: Array<Record<string, unknown>> = [];
  let finalInstruction = instruction;
  const isSquare = input.aspectRatio === "1:1";
  const maxRefs = isSquare ? 4 : 2; // empirical, undocumented non-square cap
  let refId = 0;

  for (const group of groups) {
    if (referenceImages.length >= maxRefs) break;
    refId += 1;
    if (group.tag.startsWith("@")) {
      finalInstruction = finalInstruction.replace(
        new RegExp(group.tag, "g"),
        `[${refId}]`
      );
    }
    for (const img of group.images) {
      if (referenceImages.length >= maxRefs) break;
      referenceImages.push({
        referenceType: "REFERENCE_TYPE_SUBJECT",
        referenceId: refId,
        referenceImage: { bytesBase64Encoded: img.data },
        subjectImageConfig: {
          subjectType: group.identity
            ? "SUBJECT_TYPE_PERSON"
            : "SUBJECT_TYPE_DEFAULT",
        },
      });
    }
  }

  const body = {
    instances: [
      {
        prompt: finalInstruction,
        ...(referenceImages.length ? { referenceImages } : {}),
      },
    ],
    parameters: {
      sampleCount: 1,
      personGeneration: "ALLOW_ADULT",
      ...(input.aspectRatio
        ? { aspectRatio: input.aspectRatio === "21:9" ? "16:9" : input.aspectRatio }
        : {}),
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI image error (${res.status}): ${errText.slice(0, 500)}`);
  }

  const json = await res.json();
  const output = json?.predictions?.[0];
  if (!output?.bytesBase64Encoded) {
    throw new Error("Vertex AI returned no image prediction.");
  }

  return {
    base64: output.bytesBase64Encoded,
    mimeType: output.mimeType || "image/png",
  };
}
