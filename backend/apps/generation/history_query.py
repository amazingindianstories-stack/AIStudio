"""Port of src/lib/history-query.js — the querystring<->filter contract
shared by the feed route and the counts route."""

from .generations_service import MAX_QUERY_LENGTH


def parse_history_filter(params) -> dict:
    filter: dict = {}

    project_id = params.get("projectId")
    if project_id:
        filter["projectId"] = project_id

    folder_id = params.get("folderId")
    if folder_id == "none":
        filter["folderId"] = None
    elif folder_id:
        filter["folderId"] = folder_id

    kind = params.get("kind")
    if kind in ("image", "video"):
        filter["kind"] = kind

    if params.get("favorite") == "1":
        filter["favorite"] = True

    q = (params.get("q") or "").strip()
    if q:
        filter["q"] = q[:MAX_QUERY_LENGTH]

    return filter
