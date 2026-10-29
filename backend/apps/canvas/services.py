"""Canvas persistence preserves the shared-board ownership contract."""
import json
import time
import uuid
from django.db import connection
from .models import CanvasBoard
from .serialization import empty_state

META_FIELDS = ('id', 'project_id', 'name', 'created_by', 'created_at', 'updated_at')
APPLIED_SAVE_IDS_KEPT = 50


def now_ms():
    return int(time.time() * 1000)


def metadata(row):
    return {'id': str(row['id']), 'projectId': str(row['project_id']), 'name': row['name'],
            'createdBy': str(row['created_by']) if row['created_by'] else None,
            'createdAt': row['created_at'], 'updatedAt': row['updated_at']}


def list_boards(project):
    return [metadata(row) for row in CanvasBoard.objects.filter(project_id=project).values(*META_FIELDS)]


def get_board(identifier):
    row = CanvasBoard.objects.filter(pk=identifier).values(*META_FIELDS, 'version', 'applied_save_ids', 'data').first()
    return {**metadata(row), 'version': row['version'], 'appliedSaveIds': row['applied_save_ids'],
            'data': row['data']} if row else None


def board_version(identifier):
    """The cheap poll read: never loads the graph."""
    row = CanvasBoard.objects.filter(pk=identifier).values('version', 'updated_at').first()
    return {'version': row['version'], 'updatedAt': row['updated_at']} if row else None


def can_manage(user, owner):
    return user.role == 'admin' or bool(owner) and str(user.id) == owner


def create_board(project, name, user):
    now = now_ms()
    row = CanvasBoard.objects.create(id=uuid.uuid4(), project_id=project, name=name, data=empty_state(),
                                     created_by=user.id, created_at=now, updated_at=now, version=1)
    return metadata({field: getattr(row, field) for field in META_FIELDS})


def rename_board(identifier, name):
    CanvasBoard.objects.filter(pk=identifier).update(name=name, updated_at=now_ms())


def delete_board(identifier):
    CanvasBoard.objects.filter(pk=identifier).delete()


class VersionConflict(Exception):
    """Another editor saved first; carries the current graph so the client can merge and retry."""

    def __init__(self, board):
        super().__init__('Board version conflict.')
        self.board = board


def save_board(identifier, data, base_version, save_id):
    """Write the graph only over the version the editor loaded, so concurrent editors never overwrite
    each other. A save without a base version or a save id is refused like a stale one. The save id
    joins the board's latest applied ids in the same statement, so the client can tell whether a
    draft it left behind already landed.
    The viewport is each editor's own, so a save that only pans or zooms keeps the version and open
    boards polling for changes do not refetch the graph."""
    now = now_ms()
    graph = json.dumps(data)
    row = None
    if base_version is not None and save_id is not None:
        with connection.cursor() as cursor:
            cursor.execute("UPDATE canvas_boards SET data = %s::jsonb, updated_at = %s, version = version + "
                           "CASE WHEN data - 'viewport' = %s::jsonb - 'viewport' THEN 0 ELSE 1 END, "
                           'applied_save_ids = jsonb_path_query_array(jsonb_build_array(%s::text) || applied_save_ids, '
                           '%s::jsonpath) WHERE id = %s AND version = %s RETURNING version',
                           [graph, now, graph, save_id, f'$[0 to {APPLIED_SAVE_IDS_KEPT - 1}]', identifier, base_version])
            row = cursor.fetchone()
    if row:
        return {'updatedAt': now, 'version': row[0]}
    current = get_board(identifier)
    if current is None:
        return None
    raise VersionConflict(current)
