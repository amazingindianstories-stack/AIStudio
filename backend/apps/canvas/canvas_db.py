"""Port of src/lib/canvas-db.js — canvas board persistence."""

import time
import uuid

from .canvas_serialization import empty_canvas_state
from .models import CanvasBoard


def _row_to_meta(board: CanvasBoard) -> dict:
    return {
        "id": str(board.id),
        "projectId": str(board.project_id),
        "name": board.name,
        "createdBy": str(board.created_by) if board.created_by else None,
        "createdAt": board.created_at,
        "updatedAt": board.updated_at,
    }


def list_boards(project_id: str) -> list[dict]:
    """Metadata only (omits `data`) — keeps the board switcher light."""
    return [_row_to_meta(b) for b in CanvasBoard.objects.filter(project_id=project_id)]


def get_board(board_id: str) -> dict | None:
    board = CanvasBoard.objects.filter(id=board_id).first()
    if not board:
        return None
    return {**_row_to_meta(board), "data": board.data}


def create_board(project_id: str, name: str, created_by: str | None) -> dict:
    now = int(time.time() * 1000)
    board = CanvasBoard.objects.create(
        id=uuid.uuid4(), project_id=project_id, name=name, data=empty_canvas_state(),
        created_by=created_by, created_at=now, updated_at=now,
    )
    return _row_to_meta(board)


def rename_board(board_id: str, name: str) -> None:
    CanvasBoard.objects.filter(id=board_id).update(name=name, updated_at=int(time.time() * 1000))


def delete_board(board_id: str) -> None:
    CanvasBoard.objects.filter(id=board_id).delete()


def save_board_data(board_id: str, data: dict) -> dict | None:
    """Autosave: overwrites the graph blob and bumps updatedAt. Returns
    None (rather than falsely reporting success) if the board doesn't
    exist — e.g. deleted from another tab while this one kept autosaving."""
    updated_at = int(time.time() * 1000)
    updated = CanvasBoard.objects.filter(id=board_id).update(data=data, updated_at=updated_at)
    if not updated:
        return None
    return {"updatedAt": updated_at}
