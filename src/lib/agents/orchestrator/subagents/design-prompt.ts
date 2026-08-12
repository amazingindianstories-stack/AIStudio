import { callGeminiRaw } from "../../llm-provider";
import type { GeminiPart } from "../../llm-provider";

/**
 * IMPORTANT: this prompt has to stand completely on its own, with no @img/
 * @slug tags. It gets handed to the user via a "Use this prompt" button that
 * fills PromptComposer's text field only (see OrchestratorChat.tsx) — it does
 * NOT attach these chat images as composer references, so a tag like @img1
 * here would point at nothing once pasted in and either error loudly (Kling)
 * or silently mean nothing (NBP). Describe reference material in words.
 */
const SYSTEM_PROMPT = `You are the prompt-design subagent inside Lumina Studio, an AI image/video
tool for filmmakers. Given a user's rough idea, optional notes on how
reference images should be used, and any attached reference images, produce
ONE polished, ready-to-use generation prompt.

Write a SELF-CONTAINED prompt in plain descriptive prose. Do NOT use @img,
@slug, or any other tag syntax — this prompt will be used on its own, without
the images that are attached to this conversation turn also being attached as
references at generation time. If a reference image is relevant, describe
what it shows in words (subject, styling, setting) rather than pointing at it.

Cover composition, lighting/style, and any camera or motion language if the
idea is for video. Output ONLY the prompt text — no preamble, no quotes
around it, no explanation.`;

export interface DesignPromptInput {
  idea: string;
  references?: string;
  images: GeminiPart[];
}

export interface DesignPromptResult {
  prompt: string;
}

export async function designPrompt({
  idea,
  references,
  images,
}: DesignPromptInput): Promise<DesignPromptResult> {
  const userText = [
    idea,
    references ? `Reference usage: ${references}` : null,
    images.length > 0
      ? `${images.length} reference image(s) are attached to this message.`
      : "No reference images are attached.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const { parts, finishReason } = await callGeminiRaw({
    systemPrompt: SYSTEM_PROMPT,
    contents: [{ role: "user", parts: [{ text: userText }, ...images] }],
  });

  const part = parts.find((p) => typeof p.text === "string");
  if (!part?.text) {
    throw new Error(`design_prompt subagent returned no text (${finishReason || "no candidates"}).`);
  }
  return { prompt: part.text.trim() };
}
