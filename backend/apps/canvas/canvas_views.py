"""Port of src/app/api/canvas-boards/{route,[id]/route,[id]/upload/route}.js."""

import json

from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.media.save_media import save_canvas_asset

from . import canvas_db
from .canvas_serialization import validate_canvas_state

MAX_BOARD_JSON_BYTES = 2 * 1024 * 1024


@api_view(["GET", "POST"])
def canvas_boards(request):
    if request.method == "GET":
        project_id = request.query_params.get("projectId")
        if not project_id:
            return Response({"error": "projectId required."}, status=400)
        return Response({"boards": canvas_db.list_boards(project_id)})

    body = request.data or {}
    op = body.get("op")

    if op == "createBoard":
        name = (body.get("name") or "").strip()
        project_id = body.get("projectId")
        if not project_id:
            return Response({"error": "projectId required."}, status=400)
        if not name:
            return Response({"error": "Name required."}, status=400)
        board = canvas_db.create_board(project_id, name, str(request.user.id))
        return Response({"boards": canvas_db.list_boards(project_id), "board": board})

    if op == "renameBoard":
        if not body.get("id"):
            return Response({"error": "id required."}, status=400)
        existing = canvas_db.get_board(body["id"])
        if not existing:
            return Response({"error": "Board not found."}, status=404)
        canvas_db.rename_board(body["id"], (body.get("name") or "").strip())
        return Response({"boards": canvas_db.list_boards(existing["projectId"])})

    if op == "deleteBoard":
        if not body.get("id"):
            return Response({"error": "id required."}, status=400)
        existing = canvas_db.get_board(body["id"])
        if not existing:
            return Response({"error": "Board not found."}, status=404)
        canvas_db.delete_board(body["id"])
        return Response({"boards": canvas_db.list_boards(existing["projectId"])})

    return Response({"error": "Unknown op."}, status=400)


@api_view(["GET", "PUT"])
def canvas_board_detail(request, board_id):
    if request.method == "GET":
        board = canvas_db.get_board(board_id)
        if not board:
            return Response({"error": "Board not found."}, status=404)
        return Response(board)

    body = request.data or {}
    data = body.get("data")
    if data is None or not isinstance(data, dict):
        return Response({"error": "Invalid board data."}, status=400)

    if len(json.dumps(data)) > MAX_BOARD_JSON_BYTES:
        return Response({"error": "Board is too large to save."}, status=413)

    validated = validate_canvas_state(data)
    result = canvas_db.save_board_data(board_id, validated)
    if not result:
        return Response({"error": "Board not found."}, status=404)
    return Response({"ok": True, "updatedAt": result["updatedAt"]})


@api_view(["POST"])
def canvas_board_upload(request, board_id):
    body = request.data or {}
    data_url = body.get("dataUrl")
    if not data_url or not isinstance(data_url, str) or not data_url.startswith("data:"):
        return Response({"error": "dataUrl required."}, status=400)
    try:
        url = save_canvas_asset(data_url)
        return Response({"url": url})
    except Exception:
        return Response({"error": "Upload failed."}, status=400)
