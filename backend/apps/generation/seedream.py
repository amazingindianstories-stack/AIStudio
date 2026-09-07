"""Seedream Pro input contract. No Gemini assembly or image preprocessing."""
import base64
import io
import math
import re
from PIL import Image
from apps.media import storage
from .mentions import parse_asset_slugs, parse_mention_indices, TAG_RE

SIZES = {
    "1K": {"1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1424x800", "9:16": "800x1424", "21:9": "1568x672"},
    "2K": {"1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368", "16:9": "2816x1584", "9:16": "1584x2816", "21:9": "3136x1344"},
}
def is_seedream(model):
    return model.lower() in ("seedream-5-pro", "seedream 5.0 pro")

def size(resolution=None, aspect_ratio=None):
    result = SIZES.get(resolution or "2K", {}).get(aspect_ratio or "1:1")
    if not result:
        raise ValueError("Seedream 5.0 Pro requires 1K or 2K and a supported aspect ratio.")
    return result

def resolve(prompt, assets=None, uploads=None):
    assets, uploads = assets or [], uploads or []
    if not isinstance(uploads, list) or any(not isinstance(ref, str) or not ref for ref in uploads):
        raise ValueError("Invalid reference images. Upload the images again.")
    groups = []
    for slug in parse_asset_slugs(re.sub(r"@img\d+\b", "", prompt, flags=re.I)):
        asset = next((a for a in assets if a["slug"].lower() == slug), None)
        if not asset or not asset.get("images"):
            raise ValueError(f"Missing reference @{slug}. Attach the asset or remove its tag.")
        groups.append((slug, asset["images"], f'{asset["kind"]}: {asset["name"]} — {asset.get("description") or ""}'))
    tagged = parse_mention_indices(prompt)
    if re.search(r"@img0(?![0-9])", prompt, re.I) or any(n > len(uploads) for n in tagged):
        raise ValueError("A tagged image is missing. Attach it or correct the @img number.")
    for n in tagged or range(1, len(uploads) + 1):
        groups.append((f"img{n}", [uploads[n-1]], "use as instructed in the prompt"))
    refs, names, legend = [], {}, []
    for tag, images, role in groups:
        labels = []
        for ref in images:
            refs.append(ref)
            labels.append(f"image {len(refs)}")
        names[tag] = ", ".join(labels)
        legend.append(f"{names[tag]}: {role}")
    if len(refs) > 10:
        raise ValueError(f"Seedream 5.0 Pro accepts at most 10 resolved images; this prompt resolves to {len(refs)}.")
    rewritten = re.sub(r"@img(\d+)\b", lambda m: names.get(f"img{int(m.group(1))}", m.group(0)), prompt, flags=re.I)
    rewritten = TAG_RE.sub(lambda m: names.get(m.group(1).lower(), m.group(0)), rewritten)
    text = "References:\n" + "\n".join(legend) + "\nFollow the user's editing instructions, including requested changes.\n\n" + rewritten if legend else rewritten
    return {"prompt": text, "references": refs}

def normalize(data):
    try:
        im = Image.open(io.BytesIO(data))
        if im.format not in ("JPEG", "PNG", "WEBP", "BMP", "TIFF", "GIF", "HEIF") or getattr(im, "n_frames", 1) > 1:
            raise ValueError()
        im.load()
    except Exception as exc:
        raise ValueError("Reference is corrupt, animated, unsupported, or too large to decode. Use a still PNG or JPEG.") from exc
    w, h = im.size
    if min(w, h) <= 14 or not 1/16 <= w/h <= 16:
        raise ValueError("Reference dimensions must exceed 14 pixels with an aspect ratio between 1:16 and 16:1.")
    if w*h <= 36_000_000 and len(data) <= 30_000_000:
        return data, im.format.lower(), False
    alpha = "A" in im.getbands() or "transparency" in im.info
    scale = min(1, math.sqrt(36_000_000/(w*h)))
    for _ in range(20):
        target = (int(w*scale), int(h*scale))
        if min(target) <= 14:
            break
        resized = im.convert("RGBA" if alpha else "RGB").resize(target, Image.Resampling.LANCZOS)
        out = io.BytesIO()
        resized.save(out, format="PNG" if alpha else "JPEG", quality=92)
        if out.tell() < 29_000_000:
            return out.getvalue(), "png" if alpha else "jpg", True
        scale *= .9
    raise ValueError("Reference could not fit the 30 MB limit. Export a smaller PNG or JPEG.")

def prepare(refs, item_id, user_id=None, sign=True, persist=True):
    urls = []
    for i, ref in enumerate(refs):
        key = storage.media_key_from_ref(ref)
        if not key or storage.is_protected_media_key(key) or ".." in key or "?" in key or "#" in key:
            raise ValueError("Use an uploaded or stored original image as the reference.")
        if user_id and key.startswith("uploads/image-reference/") and not key.startswith(f"uploads/image-reference/{user_id}-"):
            raise ValueError("This uploaded reference belongs to another user.")
        try:
            _, raw = storage.read_as_base64(ref)
        except Exception as exc:
            raise ValueError(f"Reference {i+1} could not be read. Upload it again.") from exc
        data, ext, changed = normalize(base64.b64decode(raw))
        stable = storage.upload_buffer(data, f"references/{item_id}-seedream-{i}.{ext}", ext) if changed and persist else ref
        if sign:
            urls.append(storage.sign_stored_ref(stable))
    return urls
