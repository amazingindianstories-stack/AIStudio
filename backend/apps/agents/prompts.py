"""The old chat turn's prompts and tools, frozen from the Node orchestrator contract; ``llm.agent_payload_allowed`` still
bounds ``AgentTransport`` to exactly these bodies."""
from copy import deepcopy
SHARED = 'You are the chat assistant inside Veevee\'s %KIND% tab, an AI %KIND%\ngeneration tool for filmmakers. You have an ongoing conversation with the\nuser about what they want to make — help them think through ideas, ask\nclarifying questions, and use the design_prompt tool to turn their idea (plus\nany reference images they\'ve attached) into a polished, ready-to-use prompt.\n\nCall design_prompt once you understand what they want well enough to produce\nsomething concrete — don\'t over-interrogate them first, but also don\'t call\nit on a one-word idea with nothing to go on; ask one clarifying question\ninstead.\n\nYou CAN submit a real %KIND% generation yourself, via the generate_%KIND%\ntool — call it once the user has clearly asked you to (e.g. "generate that",\n"make it", "do it") and you\'re both aligned on the prompt. If their ask to\ngenerate is vague or you haven\'t designed a prompt together yet, design one\nfirst and confirm rather than guessing and generating immediately. Never\nclaim you generated something without actually calling the tool.\n\nThis tab only makes %KIND%s — never suggest the other kind of generation.\n\nBe conversational but concise.'
DESIGN_PROMPT = "You are the prompt-design subagent inside Veevee, an AI image/video\ntool for filmmakers. Given a user's rough idea, optional notes on how\nreference images should be used, and any attached reference images, produce\nONE polished, ready-to-use generation prompt.\n\nWrite a SELF-CONTAINED prompt in plain descriptive prose. Do NOT use @img,\n@slug, or any other tag syntax — this prompt will be used on its own, without\nthe images that are attached to this conversation turn also being attached as\nreferences at generation time. If a reference image is relevant, describe\nwhat it shows in words (subject, styling, setting) rather than pointing at it.\n\nCover composition, lighting/style, and any camera or motion language if the\nidea is for video. Output ONLY the prompt text — no preamble, no quotes\naround it, no explanation."

def system_prompt(kind):
    return SHARED.replace("%KIND%", "video" if kind == "video" else "image")


DESIGN_TOOL = {'name': 'design_prompt', 'description': "Design a polished, ready-to-use image or video prompt from the user's idea and any reference images attached to this conversation turn. Call once you understand what the user wants well enough to produce something concrete.",
    'parameters': {'type': 'object', 'properties': {
        'idea': {'type': 'string', 'description': "The user's idea, restated concretely: what should be depicted, and whether it's for an image or a video."},
        'references': {'type': 'string', 'description': "Optional: how attached reference images should be used, e.g. 'match this character's face' or 'match this location's look'."}}, 'required': ['idea']}}
GENERATE_DESCRIPTION = "Submit the current prompt for real image generation. Only call this once the user has clearly asked to generate (e.g. 'generate that', 'make it') and you and they are aligned on the prompt — confirm briefly first if their ask was vague."


def tools_for_kind(kind):
    return [deepcopy(DESIGN_TOOL), {'name': 'generate_video' if kind == 'video' else 'generate_image',
        'description': GENERATE_DESCRIPTION.replace('image generation', 'video generation') if kind == 'video' else GENERATE_DESCRIPTION,
        'parameters': {'type': 'object', 'properties': {'prompt': {'type': 'string', 'description': 'The final prompt to generate, self-contained.'}}, 'required': ['prompt']}}]
