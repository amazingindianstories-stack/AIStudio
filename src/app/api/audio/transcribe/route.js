import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readAsBase64 } from "@/lib/storage";
import { upsertItem } from "@/lib/store-db";

export const runtime = "nodejs";
export const maxDuration = 120;

const GEMINI_MODEL = "gemini-1.5-flash";

function mimeForAudio(mime) {
  return /^(audio\/(mpeg|mp3|wav|x-wav))$/i.test(mime || "") ? mime.toLowerCase() : null;
}

export async function POST(req) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const audioRef = typeof body.audioRef === "string" ? body.audioRef : "";
  const name = typeof body.name === "string" ? body.name.slice(0, 200) : "audio";
  if (!audioRef) return NextResponse.json({ error: "Audio reference is required." }, { status: 400 });

  try {
    const raw = await readAsBase64(audioRef);
    const mimeType = mimeForAudio(raw.mimeType);
    if (!mimeType) return NextResponse.json({ error: "Only MP3 and WAV files are supported." }, { status: 400 });
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
      id, kind: "audio", status: "succeeded", prompt: transcript, model: "Gemini 1.5 Flash",
      aspectRatio: "audio", resolution: null, duration: null, referenceAudios: [audioRef],
      productionMetadata: { type: "audio-transcription", originalName: name, transcript, sourceAudio: audioRef },
      userId: user.id, costCents: 0, costBasis: "estimated", createdAt: now, updatedAt: now,
    };
    await upsertItem(item);
    return NextResponse.json({ ...item, transcript });
  } catch (e) {
    return NextResponse.json({ error: e?.message || "Transcription failed." }, { status: 500 });
  }
}
