"""Port of src/lib/save-media.js."""

import uuid

from . import storage

MAX_CANVAS_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_AVATAR_UPLOAD_BYTES = 3 * 1024 * 1024


class InvalidAvatarError(Exception):
    pass


def save_base64(b64: str, ext: str, item_id: str) -> str:
    """Save raw bytes (base64) as a generation result; returns its public URL."""
    return storage.upload_base64(b64, f"generations/{item_id}.{ext}", ext)


def save_from_url(url: str, ext: str, item_id: str) -> str:
    """Download a remote url (e.g. provider video) and store it; returns URL."""
    return storage.upload_from_url(url, f"generations/{item_id}.{ext}", ext)


def save_asset_image(data_url: str) -> str:
    """Persist an asset reference image (data URL); returns its public URL."""
    ext, data = storage.split_data_url(data_url)
    return storage.upload_base64(data, f"assets/{uuid.uuid4()}.{ext}", ext)


def delete_asset_image(url: str) -> None:
    """Delete a stored image by its public URL. Best-effort."""
    storage.delete_by_urls([url])


def save_canvas_asset(data_url: str) -> str:
    """Persist a canvas board image upload/paste (data URL); returns its
    public URL."""
    import base64

    ext, data = storage.split_data_url(data_url)
    if len(base64.b64decode(data, validate=False)) > MAX_CANVAS_UPLOAD_BYTES:
        raise ValueError("Images must be 8 MB or smaller.")
    return storage.upload_base64(data, f"canvas/{uuid.uuid4()}.{ext}", ext)


def save_avatar_image(data: bytes) -> str:
    """Normalize an uploaded profile image and store it under a
    non-reused key. Resize 512x512 cover-fit, webp q84 — mirrors sharp's
    `.resize(512, 512, {fit: "cover", position: "centre"})`."""
    import io

    from PIL import Image, ImageOps

    if not data:
        raise InvalidAvatarError("The selected image is empty.")
    if len(data) > MAX_AVATAR_UPLOAD_BYTES:
        raise InvalidAvatarError("Profile images must be 3 MB or smaller.")

    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            rgb = im.convert("RGB") if im.mode not in ("RGB", "RGBA") else im
            fitted = ImageOps.fit(rgb, (512, 512), method=Image.LANCZOS, centering=(0.5, 0.5))
            out = io.BytesIO()
            fitted.save(out, format="WEBP", quality=84)
            normalized = out.getvalue()
    except InvalidAvatarError:
        raise
    except Exception as e:
        raise InvalidAvatarError("The selected file is not a valid image.") from e

    return storage.upload_buffer(normalized, f"avatars/{uuid.uuid4()}.webp", "webp")


def delete_avatar_image(url: str | None) -> None:
    """Delete a prior profile image after a replacement/removal. Best-effort."""
    if url:
        storage.delete_by_urls([url])


def read_image_as_base64(ref: str) -> tuple[str, str]:
    """Read a stored image (public URL or data URL) back as (mime_type, base64)."""
    return storage.read_as_base64(ref)


def save_reference_images(inputs: list[str], item_id: str) -> list[str]:
    """Persist the reference images used for a generation. New data URLs
    are uploaded; existing stored URLs (e.g. cloned items) pass through
    unchanged."""
    out: list[str] = []
    n = 0
    for input_ref in inputs:
        if not isinstance(input_ref, str):
            continue
        if not input_ref.startswith("data:"):
            out.append(input_ref)
            continue
        ext, data = storage.split_data_url(input_ref)
        out.append(storage.upload_base64(data, f"references/{item_id}-{n}.{ext}", ext))
        n += 1
    return out
