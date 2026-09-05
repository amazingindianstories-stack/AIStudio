"""Port of src/lib/agents/orchestrator/tools.js."""

from .design_prompt import design_prompt

DESIGN_PROMPT_TOOL = {
    "name": "design_prompt",
    "description": (
        "Design a polished, ready-to-use image or video prompt from the user's idea and any reference images "
        "attached to this conversation turn. Call once you understand what the user wants well enough to "
        "produce something concrete."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "idea": {
                "type": "string",
                "description": "The user's idea, restated concretely: what should be depicted, and whether it's for an image or a video.",
            },
            "references": {
                "type": "string",
                "description": (
                    "Optional: how attached reference images should be used, e.g. 'match this character's "
                    "face' or 'match this location's look'."
                ),
            },
        },
        "required": ["idea"],
    },
}

GENERATE_IMAGE_TOOL = {
    "name": "generate_image",
    "description": (
        "Submit the current prompt for real image generation. Only call this once the user has clearly asked "
        "to generate (e.g. 'generate that', 'make it') and you and they are aligned on the prompt — confirm "
        "briefly first if their ask was vague."
    ),
    "parameters": {
        "type": "object",
        "properties": {"prompt": {"type": "string", "description": "The final prompt to generate, self-contained."}},
        "required": ["prompt"],
    },
}

GENERATE_VIDEO_TOOL = {
    **GENERATE_IMAGE_TOOL,
    "name": "generate_video",
    "description": GENERATE_IMAGE_TOOL["description"].replace("image generation", "video generation"),
}


def tools_for_kind(kind: str) -> list[dict]:
    return [DESIGN_PROMPT_TOOL, GENERATE_VIDEO_TOOL if kind == "video" else GENERATE_IMAGE_TOOL]


def dispatch_tool(name: str, args: dict, images: list[dict]) -> dict:
    """Returns {"response": dict, "trace": {"tool", "args", "result"}}."""
    if name == "design_prompt":
        idea = args.get("idea") if isinstance(args.get("idea"), str) else ""
        references = args.get("references") if isinstance(args.get("references"), str) else None
        result = design_prompt(idea, references, images)
        return {"response": {"prompt": result["prompt"]}, "trace": {"tool": name, "args": args, "result": result}}

    if name in ("generate_image", "generate_video"):
        prompt = args.get("prompt").strip() if isinstance(args.get("prompt"), str) else ""
        if not prompt:
            raise ValueError(f"{name} called with an empty prompt.")
        result = {"prompt": prompt}
        return {"response": {"ok": True, "prompt": prompt}, "trace": {"tool": name, "args": args, "result": result}}

    raise ValueError(f"Unknown tool: {name}")
