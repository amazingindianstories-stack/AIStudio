import time
import uuid

from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.common.activity import log_activity
from apps.media import save_media

from . import assets_service


@api_view(["GET", "POST", "DELETE"])
def assets(request):
    if request.method == "GET":
        return Response({"assets": assets_service.read_assets()})

    if request.method == "DELETE":
        asset_id = request.query_params.get("id")
        if not asset_id:
            return Response({"error": "Missing id."}, status=400)
        removed = assets_service.delete_asset(asset_id)
        if removed:
            for img in removed.images or []:
                save_media.delete_asset_image(img)
            log_activity(
                str(request.user.id),
                "delete_asset",
                {"id": asset_id, "slug": removed.slug, "name": removed.name, "kind": removed.kind},
            )
        return Response({"ok": True})

    # POST — create or update an asset.
    body = request.data or {}
    name = (body.get("name") or "").strip()
    kind = body.get("kind")
    description = (body.get("description") or "").strip()
    input_images = body.get("images") if isinstance(body.get("images"), list) else []

    if not name:
        return Response({"error": "Name is required."}, status=400)
    if kind not in assets_service.ASSET_KINDS:
        return Response({"error": "Invalid asset kind."}, status=400)

    existing = assets_service.get_asset(body.get("id")) if body.get("id") else None

    # Persist any newly-uploaded images (data URLs) to disk; keep existing paths.
    images: list[str] = []
    for img in input_images:
        if not isinstance(img, str):
            continue
        images.append(save_media.save_asset_image(img) if img.startswith("data:") else img)

    # Clean up images that were removed during an edit.
    if existing:
        kept = set(images)
        for old in existing.images or []:
            if old not in kept:
                save_media.delete_asset_image(old)

    now = int(time.time() * 1000)
    asset_id = str(existing.id) if existing else str(uuid.uuid4())
    slug = existing.slug if existing else assets_service.make_unique_slug(name)
    created_at = existing.created_at if existing else now

    assets_service.upsert_asset(
        id=asset_id,
        kind=kind,
        name=name,
        slug=slug,
        description=description or None,
        images=images,
        created_at=created_at,
        updated_at=now,
    )

    return Response(
        {
            "id": asset_id,
            "kind": kind,
            "name": name,
            "slug": slug,
            "description": description or None,
            "images": images,
            "createdAt": created_at,
            "updatedAt": now,
        }
    )
