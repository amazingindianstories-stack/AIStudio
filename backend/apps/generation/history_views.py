"""Port of src/app/api/history/{route,counts/route,updates/route,
download-zip/route}.js."""

import io
import time
import zipfile

from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.common.activity import log_activity
from apps.media import storage

from . import generations_service as gs
from .history_query import parse_history_filter


@api_view(["GET", "PATCH", "DELETE"])
def history(request):
    if request.method == "GET":
        filter = parse_history_filter(request.query_params)
        cursor = gs.decode_cursor(request.query_params.get("cursor"))

        raw_limit = request.query_params.get("limit")
        try:
            limit = max(1, min(int(raw_limit), gs.MAX_PAGE_SIZE)) if raw_limit is not None else gs.HISTORY_PAGE_SIZE
        except (TypeError, ValueError):
            limit = gs.HISTORY_PAGE_SIZE

        page = gs.query_history(filter, cursor, limit)
        return Response(page)

    if request.method == "PATCH":
        body = request.data or {}
        item_id = body.get("id")
        if not item_id:
            return Response({"error": "Missing id."}, status=400)
        if isinstance(body.get("isFavorite"), bool):
            updated = gs.set_item_favorite(item_id, body["isFavorite"])
        else:
            updated = gs.set_item_folder(item_id, body.get("projectId"), body.get("folderId"))
        if not updated:
            return Response({"error": "Not found."}, status=404)
        return Response(updated)

    # DELETE
    item_id = request.query_params.get("id")
    if not item_id:
        return Response({"error": "Missing id."}, status=400)
    item = gs.get_item(item_id)
    gs.delete_item(item_id)
    log_activity(
        str(request.user.id),
        "delete",
        {
            "id": item_id,
            "kind": item.kind if item else None,
            "model": item.model if item else None,
            "prompt": (item.prompt[:120] if item else None),
            "ownerId": str(item.user_id) if item and item.user_id else None,
        },
    )
    return Response({"ok": True})


@api_view(["GET"])
def history_counts(request):
    filter = parse_history_filter(request.query_params)
    filter.pop("folderId", None)
    favorite = filter.pop("favorite", None)  # noqa: F841 — stripped, matching the TS route

    project = gs.count_history(filter) if filter.get("projectId") else {"total": 0, "unsorted": 0, "byFolder": {}}
    all_assets = gs.count_scope({"kind": filter.get("kind"), "q": filter.get("q")})
    favorites = gs.count_scope({"kind": filter.get("kind"), "q": filter.get("q"), "favorite": True})

    return Response({"project": project, "allAssets": all_assets, "favorites": favorites})


@api_view(["GET"])
def history_updates(request):
    raw = request.query_params.get("since")
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        parsed = None
    since = parsed if parsed and parsed > 0 else time.time() * 1000 - 5 * 60_000

    items = gs.read_generation_updates(int(since))
    return Response({"items": items, "now": int(time.time() * 1000)})


def _extension_from_content_type(content_type: str | None, fallback_url: str) -> str:
    t = (content_type or "").lower()
    if "png" in t:
        return "png"
    if "webp" in t:
        return "webp"
    if "gif" in t:
        return "gif"
    if "jpeg" in t or "jpg" in t:
        return "jpg"
    if "avif" in t:
        return "avif"
    if "mp4" in t:
        return "mp4"
    url_ext = fallback_url.split("?")[0].rsplit(".", 1)[-1].lower() if "." in fallback_url.split("?")[0] else ""
    return url_ext if url_ext and len(url_ext) <= 5 else "bin"


@api_view(["POST"])
def history_download_zip(request):
    body = request.data or {}
    ids = [i for i in (body.get("ids") or []) if isinstance(i, str) and i.strip()]
    if not ids:
        return Response({"error": "No items selected."}, status=400)

    buf = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for index, item_id in enumerate(ids):
            item = gs.get_item(item_id)
            if not item or not item.url or item.kind != "image":
                continue
            key = storage.media_key_from_ref(item.url)
            if not key:
                continue
            try:
                data = storage.read_stored_buffer(key)
            except Exception:
                continue
            ext = _extension_from_content_type(None, item.url)
            zf.writestr(f"{str(index + 1).zfill(2)}-{item.id}.{ext}", data)
            count += 1

    if not count:
        return Response({"error": "No downloadable images found."}, status=400)

    from django.http import HttpResponse

    filename = f"assets-{time.strftime('%Y-%m-%d')}.zip"
    zip_bytes = buf.getvalue()
    response = HttpResponse(zip_bytes, content_type="application/zip")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Content-Length"] = str(len(zip_bytes))
    response["Cache-Control"] = "no-store"
    return response
