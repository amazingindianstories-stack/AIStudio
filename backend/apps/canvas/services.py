"""Canvas persistence preserves the shared-board ownership contract."""
import json
import logging
import time
import uuid
from django.db import connection, transaction
from .models import CanvasBoard, CanvasBoardSave
from .serialization import empty_state

META_FIELDS = ('id', 'project_id', 'name', 'created_by', 'created_at', 'updated_at')
# Applied save ids are kept this long; the editor treats older drafts as having no usable base.
SAVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

logger = logging.getLogger('veevee.maintenance')


def now_ms():
    return int(time.time() * 1000)


def metadata(row):
    return {'id': str(row['id']), 'projectId': str(row['project_id']), 'name': row['name'],
            'createdBy': str(row['created_by']) if row['created_by'] else None,
            'createdAt': row['created_at'], 'updatedAt': row['updated_at']}


def list_boards(project):
    return [metadata(row) for row in CanvasBoard.objects.filter(project_id=project).values(*META_FIELDS)]


def get_board(identifier, save_id=None):
    """With a `save_id`, also the version that save landed at (None when it never landed or has expired)."""
    row = CanvasBoard.objects.filter(pk=identifier).values(*META_FIELDS, 'version', 'data').first()
    if row is None:
        return None
    board = {**metadata(row), 'version': row['version'], 'data': row['data']}
    if save_id is not None:
        board['saveVersion'] = CanvasBoardSave.objects.filter(board_id=identifier, save_id=save_id).values_list(
            'version', flat=True).first()
    return board


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
    with transaction.atomic():
        CanvasBoard.objects.filter(pk=identifier).delete()
        CanvasBoardSave.objects.filter(board_id=identifier).delete()


class VersionConflict(Exception):
    """Another editor saved first; carries the current graph so the client can merge and retry."""

    def __init__(self, board):
        super().__init__('Board version conflict.')
        self.board = board


def save_board(identifier, data, base_version, save_id):
    """Write the graph only over the version the editor loaded, so concurrent editors never overwrite
    each other. A save without a base version or a save id is refused like a stale one. A save that
    changes the graph records its save id and version in the same transaction, so the editor can tell
    whether a save whose response it never received landed.
    The viewport is each editor's own, so a save that only pans or zooms keeps the version, records
    nothing, and open boards polling for changes do not refetch the graph."""
    now = now_ms()
    graph = json.dumps(data)
    row = None
    if base_version is not None and save_id is not None:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("UPDATE canvas_boards SET data = %s::jsonb, updated_at = %s, version = version + "
                           "CASE WHEN data - 'viewport' = %s::jsonb - 'viewport' THEN 0 ELSE 1 END "
                           'WHERE id = %s AND version = %s RETURNING version', [graph, now, graph, identifier, base_version])
            row = cursor.fetchone()
            if row and row[0] != base_version:
                cursor.execute('INSERT INTO canvas_board_saves (board_id, save_id, version, applied_at) '
                               'VALUES (%s, %s, %s, %s) ON CONFLICT (board_id, save_id) DO NOTHING',
                               [identifier, save_id, row[0], now])
    if row:
        return {'updatedAt': now, 'version': row[0]}
    current = get_board(identifier)
    if current is None:
        return None
    raise VersionConflict(current)


def prune_board_saves(now=None):
    """Scheduler job: forget applied save ids older than the retention window."""
    now = now_ms() if now is None else now
    deleted = CanvasBoardSave.objects.filter(applied_at__lte=now - SAVE_RETENTION_MS).delete()[0]
    logger.info(json.dumps({'event': 'maintenance_cleanup', 'target': 'canvas_board_saves', 'deleted': deleted}))
    return {'ok': True, 'deleted': deleted}
