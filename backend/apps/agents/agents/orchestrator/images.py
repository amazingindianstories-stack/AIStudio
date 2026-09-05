"""Port of src/lib/agents/orchestrator/images.js."""

from apps.media import storage

EXT_TO_MIME = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif"}


def images_to_parts(data_urls: list[str]) -> list[dict]:
    """Converts user-attached reference image data URLs into Gemini
    inlineData parts. Reuses storage.split_data_url's MIME allowlist."""
    parts = []
    for url in data_urls:
        ext, data = storage.split_data_url(url)
        parts.append({"inlineData": {"mimeType": EXT_TO_MIME[ext], "data": data}})
    return parts
