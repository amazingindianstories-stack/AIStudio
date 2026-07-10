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

export interface CandidateScore {
  identity: number; // 0–100, same forensic rubric as judgeIdentity
  prominence: number; // 0–100: how large/near/centered the subject's face is
  sharpness: number; // 0–100: crispness of the subject's FACE region (not whole frame)
}

/** One extended Gemini-2.5-flash call scoring identity + subject prominence +
 *  face sharpness in a single pass (no extra calls beyond judgeIdentity's
 *  cost). Returns null on any failure (fail-open, same as judgeIdentity). */
export async function judgeCandidate(
  refFace: JudgeImage,
  candidate: JudgeImage
): Promise<CandidateScore | null> {
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
                    `Score IMAGE 2 on three axes and answer JSON: ` +
                    `{"identity": 0-100, "prominence": 0-100, "sharpness": 0-100}. ` +
                    `"identity": compare the main character's face in IMAGE 2 to IMAGE 1 ` +
                    `like a forensic examiner — bone structure, jawline, eye shape/spacing, ` +
                    `eyebrows, nose, lips, face shape, apparent age; 100 = unmistakably the ` +
                    `SAME person, 50 = related-looking, 0 = a different person. ` +
                    `"prominence": how large, near-camera and centered the main subject's ` +
                    `face is within IMAGE 2's frame; 100 = a large, clearly framed hero ` +
                    `subject, 0 = tiny/distant/barely visible. ` +
                    `"sharpness": how crisp and in-focus the main subject's FACE region ` +
                    `specifically is (not the whole frame — ignore background blur/grain); ` +
                    `100 = tack sharp facial detail, 0 = soft/blurred/smeared face.`,
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
    const parsed = JSON.parse(text);
    const clamp = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
    };
    const identity = clamp(parsed?.identity);
    const prominence = clamp(parsed?.prominence);
    const sharpness = clamp(parsed?.sharpness);
    if (identity === null || prominence === null || sharpness === null) return null;
    return { identity, prominence, sharpness };
  } catch {
    return null;
  }
}

/** Pure selector. Among candidates whose identity is within `slack` of the max
 *  identity (the identity FLOOR — guarantees identity never regresses vs the
 *  identity-only picker), choose the highest composite = prominence + sharpness.
 *  Ties break toward higher identity, then lower index. Nulls score as -1 and
 *  are only picked if all are null. Returns the winning index. */
export function selectBestCandidate(
  scores: Array<CandidateScore | null>,
  slack = 8
): number {
  const identityOf = (s: CandidateScore | null) => (s ? s.identity : -1);
  const maxIdentity = scores.reduce((m, s) => Math.max(m, identityOf(s)), -1);

  // All null (maxIdentity === -1): nothing to rank — first candidate wins.
  if (maxIdentity === -1) return 0;

  let best = -1;
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!s) continue; // nulls excluded whenever any real score exists
    if (s.identity < maxIdentity - slack) continue; // below the identity floor

    if (best === -1) {
      best = i;
      continue;
    }
    const bestScore = scores[best] as CandidateScore;
    const composite = s.prominence + s.sharpness;
    const bestComposite = bestScore.prominence + bestScore.sharpness;
    if (
      composite > bestComposite ||
      (composite === bestComposite && s.identity > bestScore.identity)
    ) {
      best = i;
    }
  }
  return best === -1 ? 0 : best;
}
