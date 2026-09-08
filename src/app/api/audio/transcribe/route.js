import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readAsBase64 } from "@/lib/storage";
import { upsertItem } from "@/lib/store-db";

export const runtime = "nodejs";
export const maxDuration = 120;

// Gemini 1.5 Flash has been retired and returns 404. Keep the model
// configurable for future rotations; 2.5 Flash supports audio input and text.
const GEMINI_MODEL = process.env.AUDIO_TRANSCRIPTION_MODEL || "gemini-2.5-flash";

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

function mimeForAudio(mime) {
  return /^(audio\/(mpeg|mp3|wav|x-wav|wave|ogg|webm|mp4|x-m4a|aac|flac))$/i.test(mime || "") ? mime.toLowerCase() : null;
}

export async function POST(req) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const audioRef = typeof body.audioRef === "string" ? body.audioRef : "";
  const name = typeof body.name === "string" ? body.name.slice(0, 200) : "audio";
  const projectId = typeof body.projectId === "string" && body.projectId.trim() ? body.projectId.trim() : null;
  if (!audioRef) return NextResponse.json({ error: "Audio reference is required." }, { status: 400 });

  try {
    const raw = await readAsBase64(audioRef);
    const mimeType = mimeForAudio(raw.mimeType);
    if (!mimeType) return NextResponse.json({ error: "Use a common audio file such as MP3, WAV, M4A, OGG, AAC, FLAC or WebM." }, { status: 400 });
    if (Buffer.byteLength(raw.data, "base64") > MAX_AUDIO_BYTES) {
      return NextResponse.json({ error: "Audio files must be 15 MB or smaller." }, { status: 413 });
    }
    if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not configured.");
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GOOGLE_API_KEY || "" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inlineData: { mimeType, data: raw.data } },
            { text: "Transcribe this audio for use as a video-generation prompt. Return only a clean, timestamped transcript in this exact format, one line per segment: [MM:SS.mmm - MM:SS.mmm] Speaker or sound: words or description. Include meaningful music, ambience, sound effects, pauses, and speaker changes. Do not add a title, markdown fence, commentary, or invented content." },
          ] }],
          generationConfig: { temperature: 0.1 },
        }),
      }
    );
    if (!response.ok) throw new Error(`Gemini transcription failed (${response.status}).`);
    const json = await response.json();
    const transcript = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n").trim();
    if (!transcript) throw new Error("Gemini returned an empty transcription.");
    const id = crypto.randomUUID();
    const now = Date.now();
    const item = {
      id, kind: "audio", status: "succeeded", prompt: transcript, model: `Gemini (${GEMINI_MODEL})`,
      aspectRatio: "audio", resolution: null, duration: null, referenceAudios: [audioRef],
      projectId,
      productionMetadata: { type: "audio-transcription", originalName: name, transcript, sourceAudio: audioRef },
      userId: user.id, costCents: 0, costBasis: "estimated", createdAt: now, updatedAt: now,
    };
    await upsertItem(item);
    return NextResponse.json({ ...item, transcript });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "Transcription failed." }, { status: 500 });
  }
}
