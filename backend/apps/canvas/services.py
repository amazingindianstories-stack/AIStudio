"""Canvas persistence preserves the shared-board ownership contract."""
import json
import logging
import time
import uuid
from django.db import connection, models, transaction
from .models import BoardActivity, CanvasBoard, CanvasBoardSave
from .serialization import MAX_BOARD_JSON_UNITS, empty_state, json_length, validate_state

META_FIELDS = ('id', 'project_id', 'name', 'created_by', 'created_at', 'updated_at', 'team_role')
# Applied save ids are kept this long; the editor treats older drafts as having no usable base.
SAVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

logger = logging.getLogger('veevee.maintenance')


def now_ms():
    return int(time.time() * 1000)


def metadata(row):
    return {'id': str(row['id']), 'projectId': str(row['project_id']), 'name': row['name'],
            'createdBy': str(row['created_by']) if row['created_by'] else None,
            'createdAt': row['created_at'], 'updatedAt': row['updated_at'], 'teamRole': row['team_role']}


def list_boards(project, user):
    """The project's boards the user may at least view, each carrying the user's effective role."""
    from . import access
    rows = list(CanvasBoard.objects.filter(project_id=project).values(*META_FIELDS))
    levels = access.roles_for(user, rows)
    return [{**metadata(row), 'role': access.LEVEL_NAMES[levels[str(row['id'])]]}
            for row in rows if levels[str(row['id'])] >= access.READ]


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
    """The cheap poll read: one row with the fields the role check needs, never the graph."""
    return CanvasBoard.objects.filter(pk=identifier).values(
        'id', 'project_id', 'created_by', 'team_role', 'version', 'updated_at').first()


def create_board(project, name, user):
    now = now_ms()
    row = CanvasBoard.objects.create(id=uuid.uuid4(), project_id=project, name=name, data=empty_state(),
                                     created_by=user.id, created_at=now, updated_at=now, version=1)
    return {**metadata({**{field: getattr(row, field) for field in META_FIELDS}, 'team_role': 'edit'}), 'role': 'owner'}


def rename_board(identifier, name):
    CanvasBoard.objects.filter(pk=identifier).update(name=name, updated_at=now_ms())


def delete_board(identifier):
    with transaction.atomic():
        CanvasBoard.objects.filter(pk=identifier).delete()
        CanvasBoardSave.objects.filter(board_id=identifier).delete()
        BoardActivity.objects.filter(board_id=identifier).delete()


class VersionConflict(Exception):
    """Another editor saved first; carries the current graph so the client can merge and retry."""

    def __init__(self, board):
        super().__init__('Board version conflict.')
        self.board = board


class BoardTooLarge(Exception):
    """The graph with its server stamps is over the save limit."""


def _graph(data):
    return {key: value for key, value in data.items() if key != 'viewport'} if isinstance(data, dict) else data


def save_board(identifier, data, base_version, save_id, actor):
    """Write the graph only over the version the editor loaded, so concurrent editors never overwrite
    each other. A save without a base version or a save id is refused like a stale one. The board row is
    locked while the save is compared with the graph it replaces (apps.canvas.activity): changed objects
    get server stamps and one activity row each, and a save that changes the graph records its save id
    and version, all in that transaction, so the editor can tell whether a save whose response it never
    received landed. Returns the new version and the stamps the save gave, which the editor adopts.
    The viewport is each editor's own, so a save that only pans or zooms keeps the version, records
    nothing, and open boards polling for changes do not refetch the graph."""
    from . import activity
    now = now_ms()
    actor = str(actor)
    if base_version is not None and save_id is not None:
        with transaction.atomic():
            row = CanvasBoard.objects.select_for_update().filter(pk=identifier).values('version', 'data').first()
            if row and row['version'] == base_version:
                stamped, changes = activity.stamp(validate_state(row['data']), data, actor, now)
                if json_length(stamped) > MAX_BOARD_JSON_UNITS:
                    raise BoardTooLarge()
                version = base_version + 1 if _graph(stamped) != _graph(row['data']) else base_version
                CanvasBoard.objects.filter(pk=identifier).update(data=stamped, updated_at=now, version=version)
                if version != base_version:
                    with connection.cursor() as cursor:
                        cursor.execute('INSERT INTO canvas_board_saves (board_id, save_id, version, applied_at) '
                                       'VALUES (%s, %s, %s, %s) ON CONFLICT (board_id, save_id) DO NOTHING',
                                       [identifier, save_id, version, now])
                    activity.record(identifier, actor, now, changes)
                return {'updatedAt': now, 'version': version, 'stamps': activity.stamps_of(stamped, changes)}
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


ACTIVITY_PAGE = 100


def board_activity(identifier, before=None):
    """The board's History, newest first, one page at a time; `before` is the previous page's `next`."""
    rows = BoardActivity.objects.filter(board_id=identifier)
    if before is not None:
        created_at, ordinal = before
        rows = rows.filter(models.Q(created_at__lt=created_at) | models.Q(created_at=created_at, ordinal__lt=ordinal))
    page = list(rows.order_by('-created_at', '-ordinal').values(
        'actor_id', 'action', 'node_id', 'node_type', 'snippet', 'created_at', 'ordinal')[:ACTIVITY_PAGE + 1])
    more = len(page) > ACTIVITY_PAGE
    page = page[:ACTIVITY_PAGE]
    return {'activity': [{'actorId': str(row['actor_id']) if row['actor_id'] else None, 'action': row['action'],
                          'nodeId': row['node_id'], 'nodeType': row['node_type'], 'snippet': row['snippet'],
                          'at': row['created_at']} for row in page],
            'next': f"{page[-1]['created_at']}.{page[-1]['ordinal']}" if more else None}


def prune_board_activity(now=None):
    """Scheduler job: drop History rows older than the retention window."""
    from .activity import ACTIVITY_RETENTION_MS
    now = now_ms() if now is None else now
    deleted = BoardActivity.objects.filter(created_at__lte=now - ACTIVITY_RETENTION_MS).delete()[0]
    logger.info(json.dumps({'event': 'maintenance_cleanup', 'target': 'board_activity', 'deleted': deleted}))
    return {'ok': True, 'deleted': deleted}
