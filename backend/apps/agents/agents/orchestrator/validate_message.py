"""Port of src/lib/agents/orchestrator/validate-message.js."""

MAX_CONTENT_LEN = 8000
MAX_IMAGES = 4


def parse_message_body(body) -> dict:
    """Returns {"content", "images"} or {"error": str}."""
    b = body if isinstance(body, dict) else {}
    content = b.get("content").strip() if isinstance(b.get("content"), str) else ""
    if not content:
        return {"error": "content is required."}
    if len(content) > MAX_CONTENT_LEN:
        return {"error": f"Message is too long (max {MAX_CONTENT_LEN} characters)."}

    raw = b.get("images")
    if raw is not None and not isinstance(raw, list):
        return {"error": "images must be an array of data URLs."}
    images = [v for v in raw if isinstance(v, str)] if isinstance(raw, list) else []
    if len(images) > MAX_IMAGES:
        return {"error": f"Attach at most {MAX_IMAGES} reference images per message."}

    return {"content": content, "images": images}
