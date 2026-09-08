import os
import time
import requests
from ..seedream import size

def payload(prompt, resolution=None, aspect_ratio=None, references=None):
    references = references or []
    if not prompt.strip() or len(references) > 10:
        raise ValueError("Seedream requires a prompt and at most 10 references.")
    body = {"model": os.environ.get("SEEDREAM_MODEL") or "dola-seedream-5-0-pro-260628", "prompt": prompt, "size": size(resolution, aspect_ratio), "response_format": "url", "output_format": "png", "watermark": False, "optimize_prompt_options": {"mode": "standard"}}
    if references:
        body["image"] = references
    return body

def generate(prompt, resolution=None, aspect_ratio=None, references=None):
    key = os.environ.get("ARK_API_KEY")
    if not key or key == "[SENSITIVE]":
        raise ValueError("Seedream is not configured: ARK_API_KEY is missing or redacted.")
    body = payload(prompt, resolution, aspect_ratio, references)
    started = time.monotonic()
    try:
        response = requests.post((os.environ.get("ARK_BASE_URL") or "https://ark.ap-southeast.bytepluses.com/api/v3").rstrip("/") + "/images/generations", headers={"Authorization": f"Bearer {key}"}, json=body, timeout=(10, 210))
    except requests.RequestException as exc:
        raise RuntimeError("Seedream connection ended without a confirmed result. It may have been charged; it was not resubmitted.") from exc
    try:
        result = response.json()
    except ValueError as exc:
        raise RuntimeError("Seedream returned malformed JSON. The request was not resubmitted.") from exc
    if not response.ok or result.get("error"):
        raise RuntimeError(f"Seedream rejected the request (HTTP {response.status_code}). Check model access, rate limits, references and content requirements.")
    images = result.get("data") or []
    if len(images) != 1 or not isinstance(images[0].get("url"), str) or not images[0]["url"].startswith("https://"):
        raise RuntimeError("Seedream returned no valid single-image result. The request was not resubmitted.")
    remaining = 260 - (time.monotonic() - started)
    if remaining <= 0:
        raise RuntimeError("Seedream exceeded the queue deadline. The request was not resubmitted.")
    try:
        fetched = requests.get(images[0]["url"], timeout=(10, min(45, remaining)))
    except requests.RequestException as exc:
        raise RuntimeError("Seedream image download failed. The request was not resubmitted.") from exc
    if not fetched.ok:
        raise RuntimeError("Seedream produced an image but download failed. The request was not resubmitted.")
    return fetched.content
