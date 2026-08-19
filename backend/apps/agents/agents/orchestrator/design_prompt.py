"""Port of src/lib/agents/orchestrator/subagents/design-prompt.js.

IMPORTANT: this prompt has to stand completely on its own, with no @img/
@slug tags — it's handed to the user via a "Use this prompt" button that
fills the composer's text field only, without attaching these chat images
as composer references. Describe reference material in words.
"""

from .. import llm_provider

SYSTEM_PROMPT = """You are the prompt-design subagent inside Veevee, an AI image/video
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
around it, no explanation."""


def design_prompt(idea: str, references: str | None, images: list[dict]) -> dict:
    """images: [GeminiPart, ...]. Returns {"prompt": str}."""
    user_text = "\n\n".join(
        filter(None, [
            idea,
            f"Reference usage: {references}" if references else None,
            f"{len(images)} reference image(s) are attached to this message." if images else "No reference images are attached.",
        ])
    )

    result = llm_provider.call_gemini_raw(SYSTEM_PROMPT, [{"role": "user", "parts": [{"text": user_text}, *images]}])
    part = next((p for p in result["parts"] if isinstance(p.get("text"), str)), None)
    if not part or not part.get("text"):
        raise RuntimeError(f"design_prompt subagent returned no text ({result.get('finishReason') or 'no candidates'}).")
    return {"prompt": part["text"].strip()}
