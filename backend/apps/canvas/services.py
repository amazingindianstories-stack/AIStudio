"""Canvas persistence preserves the shared-board ownership contract."""
import json
import time
import uuid
from django.db import connection
from .models import CanvasBoard
from .serialization import empty_state

META_FIELDS = ('id', 'project_id', 'name', 'created_by', 'created_at', 'updated_at')


def now_ms():
    return int(time.time() * 1000)


def metadata(row):
    return {'id': str(row['id']), 'projectId': str(row['project_id']), 'name': row['name'],
            'createdBy': str(row['created_by']) if row['created_by'] else None,
            'createdAt': row['created_at'], 'updatedAt': row['updated_at']}


def list_boards(project):
    return [metadata(row) for row in CanvasBoard.objects.filter(project_id=project).values(*META_FIELDS)]


def get_board(identifier):
    row = CanvasBoard.objects.filter(pk=identifier).values(*META_FIELDS, 'version', 'data').first()
    return {**metadata(row), 'version': row['version'], 'data': row['data']} if row else None


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


def save_board(identifier, data, base_version=None):
    """Write the graph only over the version the editor loaded, so concurrent editors never overwrite
    each other. A missing base version is an unconditional write from a client that predates versions.
    The viewport is each editor's own, so a save that only pans or zooms keeps the version and open
    boards polling for changes do not refetch the graph."""
    now = now_ms()
    graph = json.dumps(data)
    condition = '' if base_version is None else ' AND version = %s'
    params = [graph, now, graph, identifier] + ([] if base_version is None else [base_version])
    with connection.cursor() as cursor:
        cursor.execute("UPDATE canvas_boards SET data = %s::jsonb, updated_at = %s, version = version + "
                       "CASE WHEN data - 'viewport' = %s::jsonb - 'viewport' THEN 0 ELSE 1 END "
                       'WHERE id = %s' + condition + ' RETURNING version', params)
        row = cursor.fetchone()
    if row:
        return {'updatedAt': now, 'version': row[0]}
    current = None if base_version is None else get_board(identifier)
    if current is None:
        return None
    raise VersionConflict(current)
