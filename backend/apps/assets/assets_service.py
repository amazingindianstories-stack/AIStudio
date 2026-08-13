"""Port of src/lib/assets-db.js. Reusable reference assets."""

import re
import time
import uuid

from .models import Asset

ASSET_KINDS = ("character", "outfit", "location", "style", "prop")


def _serialize(asset: Asset) -> dict:
    return {
        "id": str(asset.id),
        "kind": asset.kind,
        "name": asset.name,
        "slug": asset.slug,
        "description": asset.description,
        "images": asset.images or [],
        "createdAt": asset.created_at,
        "updatedAt": asset.updated_at,
    }


def read_assets() -> list[dict]:
    return [_serialize(a) for a in Asset.objects.order_by("-created_at")]


def get_asset(asset_id: str) -> Asset | None:
    return Asset.objects.filter(id=asset_id).first()


def upsert_asset(
    *, id: str, kind: str, name: str, slug: str, description: str | None, images: list[str], created_at: int, updated_at: int
) -> None:
    Asset.objects.update_or_create(
        id=id,
        defaults={
            "kind": kind,
            "name": name,
            "slug": slug,
            "description": description,
            "images": images,
            "created_at": created_at,
            "updated_at": updated_at,
        },
    )


def delete_asset(asset_id: str) -> Asset | None:
    asset = Asset.objects.filter(id=asset_id).first()
    if asset:
        asset_copy = Asset(
            id=asset.id, kind=asset.kind, name=asset.name, slug=asset.slug,
            description=asset.description, images=asset.images,
            created_at=asset.created_at, updated_at=asset.updated_at,
        )
        Asset.objects.filter(id=asset_id).delete()
        return asset_copy
    return None


def make_unique_slug(name: str, exclude_id: str | None = None) -> str:
    base = re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", name.lower().strip()))[:32] or "asset"
    taken = set(
        Asset.objects.exclude(id=exclude_id).values_list("slug", flat=True)
        if exclude_id
        else Asset.objects.values_list("slug", flat=True)
    )
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"
