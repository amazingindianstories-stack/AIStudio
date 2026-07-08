/**
 * Gemini-as-judge for face identity (server-only). Scores how well the main
 * character's face in a generated frame matches the identity reference.
 * Validated in scripts/ab-face-eval.ts: with generation being stochastic
 * (same config swings 15–88), judging N candidates and keeping the best is
 * worth more than any single-pass prompt trick.
 */

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

export interface JudgeImage {
  mimeType: string;
  data: string; // base64
}

/** 0–100 identity score, or null when judging is unavailable (fail-open). */
export async function judgeIdentity(
  refFace: JudgeImage,
  candidate: JudgeImage
): Promise<number | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_DETECT_MODEL || "gemini-2.5-flash";
  try {
    const res = await fetch(
      `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "IMAGE 1 — ground-truth reference face of a specific person:" },
                { inlineData: { mimeType: refFace.mimeType, data: refFace.data } },
                {
                  text:
                    "IMAGE 2 — a generated cinematic frame whose main character is supposed to be that exact person:",
                },
                { inlineData: { mimeType: candidate.mimeType, data: candidate.data } },
                {
                  text:
                    `Compare the main character's face in IMAGE 2 to IMAGE 1 ` +
                    `like a forensic examiner: bone structure, jawline, eye ` +
                    `shape/spacing, eyebrows, nose, lips, face shape, apparent ` +
                    `age. Answer JSON: {"identity": 0-100} where 100 = ` +
                    `unmistakably the SAME person, 50 = related-looking, ` +
                    `0 = a different person.`,
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
          },
        }),
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const text = (json?.candidates?.[0]?.content?.parts ?? []).find(
      (p: any) => typeof p?.text === "string"
    )?.text;
    const score = Number(JSON.parse(text)?.identity);
    return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
  } catch {
    return null;
  }
}
