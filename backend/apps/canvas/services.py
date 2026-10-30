"""Canvas persistence preserves the shared-board ownership contract."""
import json
import logging
import time
import uuid
from django.db import connection, models, transaction
from .models import BoardActivity, CanvasBoard, CanvasBoardSave, CustomShapePack
from .serialization import JS_WHITESPACE, MAX_BOARD_JSON_UNITS, content_length, empty_state, validate_state
from .svg_sanitize import MAX_SHAPES_PER_PACK, sanitize_svg

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
    """The normalized graph is over the save limit."""


def _graph(data):
    return {key: value for key, value in data.items() if key != 'viewport'} if isinstance(data, dict) else data


def save_board(identifier, data, base_version, save_id, actor, patch=None):
    """Write the graph only over the version the editor loaded, so concurrent editors never overwrite
    each other. A save without a base version or a save id is refused like a stale one. The board row is
    locked while the save is compared with the graph it replaces (apps.canvas.activity): changed objects
    get server stamps and one activity row each, and a save that changes the graph records its save id
    and version, all in that transaction, so the editor can tell whether a save whose response it never
    received landed. Returns the new version and the stamps the save gave, which the editor adopts.
    The viewport is each editor's own, so a save that only pans or zooms keeps the version, records
    nothing, and open boards polling for changes do not refetch the graph.
    With a `patch` (apps.canvas.patch) instead of `data`, the graph saved is the patch applied to the stored
    one; everything above then runs on that whole graph, so a patch and the full graph it stands for save alike.
    The save id row also records which objects the save changed, for `board_changes`."""
    from . import activity, patch as board_patch
    now = now_ms()
    actor = str(actor)
    if base_version is not None and save_id is not None:
        with transaction.atomic():
            row = CanvasBoard.objects.select_for_update().filter(pk=identifier).values('version', 'data').first()
            if row and row['version'] == base_version:
                stored = validate_state(row['data'])
                if patch is not None:
                    data = validate_state(board_patch.apply_patch(stored, patch))
                stamped, changes = activity.stamp(stored, data, actor, now)
                if content_length(stamped) > MAX_BOARD_JSON_UNITS:
                    raise BoardTooLarge()
                version = base_version + 1 if _graph(stamped) != _graph(row['data']) else base_version
                CanvasBoard.objects.filter(pk=identifier).update(data=stamped, updated_at=now, version=version)
                if version != base_version:
                    with connection.cursor() as cursor:
                        changed = board_patch.changed_ids(stored, stamped)
                        cursor.execute('INSERT INTO canvas_board_saves (board_id, save_id, version, applied_at, changes) '
                                       'VALUES (%s, %s, %s, %s, %s) ON CONFLICT (board_id, save_id) DO NOTHING',
                                       [identifier, save_id, version, now,
                                        None if changed is None else json.dumps(changed)])
                    activity.record(identifier, actor, now, changes)
                return {'updatedAt': now, 'version': version, 'stamps': activity.stamps_of(stamped, changes)}
    current = get_board(identifier)
    if current is None:
        return None
    raise VersionConflict(current)


def board_changes(identifier, since):
    """What an editor holding version `since` needs to reach the current version: the objects changed since
    then (apps.canvas.patch.changes_since), or the whole graph when a version in between recorded no ids,
    has been pruned, or is too far back. None when the board does not exist."""
    from . import patch as board_patch
    row = CanvasBoard.objects.filter(pk=identifier).values('version', 'updated_at', 'data').first()
    if row is None:
        return None
    reply = {'version': row['version'], 'updatedAt': row['updated_at']}
    graph = validate_state(row['data'])
    behind = row['version'] - since
    changes = None
    if 0 <= behind <= board_patch.MAX_CHANGE_VERSIONS:
        records = dict(CanvasBoardSave.objects.filter(board_id=identifier, version__gt=since,
                                                      version__lte=row['version']).values_list('version', 'changes'))
        if len(records) == behind:
            changes = board_patch.changes_since(graph, list(records.values()))
    return {**reply, 'changes': changes} if changes is not None else {**reply, 'data': row['data']}


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


def _pack_dict(row, user):
    is_owner = str(row.created_by) == str(user.id) or getattr(user, 'role', None) == 'admin'
    return {
        'id': str(row.id),
        'name': row.name,
        'createdBy': str(row.created_by),
        'isOwner': is_owner,
        'shared': bool(row.shared),
        'showNames': bool(row.show_names),
        'shapes': row.shapes if isinstance(row.shapes, list) else [],
        'createdAt': row.created_at,
        'updatedAt': row.updated_at,
    }


def normalize_pack_shapes(raw_shapes):
    if not isinstance(raw_shapes, list):
        raise ValueError('shapes must be a list.')
    if len(raw_shapes) > MAX_SHAPES_PER_PACK:
        raise ValueError(f'A custom shape pack can contain at most {MAX_SHAPES_PER_PACK} shapes.')
    normalized = []
    seen_ids = set()
    for index, item in enumerate(raw_shapes):
        if not isinstance(item, dict):
            raise ValueError('Each shape must be an object.')
        raw_id = item.get('id')
        shape_id = raw_id.strip(JS_WHITESPACE)[:80] if isinstance(raw_id, str) and raw_id.strip(JS_WHITESPACE) else f'shape-{uuid.uuid4().hex[:10]}'
        if shape_id in seen_ids:
            shape_id = f'{shape_id}-{index + 1}'
        seen_ids.add(shape_id)
        raw_name = item.get('name')
        shape_name = raw_name.strip(JS_WHITESPACE)[:120] if isinstance(raw_name, str) and raw_name.strip(JS_WHITESPACE) else f'Shape {index + 1}'
        inner_svg, view_box = sanitize_svg(item.get('svg'))
        if isinstance(item.get('viewBox'), str) and item['viewBox'].strip(JS_WHITESPACE) and '<svg' not in str(item.get('svg', '')).lower():
            from .svg_sanitize import SAFE_VIEWBOX_RE
            vb_candidate = item['viewBox'].strip(JS_WHITESPACE)
            if SAFE_VIEWBOX_RE.match(vb_candidate):
                view_box = ' '.join(vb_candidate.split())
        normalized.append({
            'id': shape_id,
            'name': shape_name,
            'svg': inner_svg,
            'viewBox': view_box,
        })
    return normalized


def list_shape_packs(user):
    rows = CustomShapePack.objects.filter(
        models.Q(created_by=user.id) | models.Q(shared=True)
    ).order_by('-updated_at', 'name')
    return [_pack_dict(row, user) for row in rows]


def create_shape_pack(user, data):
    raw_name = data.get('name') if isinstance(data, dict) else None
    name = raw_name.strip(JS_WHITESPACE)[:120] if isinstance(raw_name, str) else ''
    if not name:
        raise ValueError('Pack name is required.')
    raw_shapes = data.get('shapes', []) if isinstance(data, dict) else []
    shapes = normalize_pack_shapes(raw_shapes if raw_shapes is not None else [])
    shared = bool(data.get('shared', False)) if isinstance(data, dict) else False
    show_names = bool(data.get('showNames', True)) if isinstance(data, dict) else True
    now = now_ms()
    row = CustomShapePack.objects.create(
        id=uuid.uuid4(),
        name=name,
        created_by=user.id,
        shared=shared,
        show_names=show_names,
        shapes=shapes,
        created_at=now,
        updated_at=now,
    )
    return _pack_dict(row, user)


def update_shape_pack(user, identifier, data):
    from . import access
    row = CustomShapePack.objects.filter(pk=identifier).first()
    if row is None:
        return None
    if str(row.created_by) != str(user.id) and getattr(user, 'role', None) != 'admin':
        raise access.AccessError('Only the pack owner can edit this shape pack.', 403)
    if not isinstance(data, dict):
        raise ValueError('Invalid shape pack update.')
    if 'name' in data:
        raw_name = data.get('name')
        name = raw_name.strip(JS_WHITESPACE)[:120] if isinstance(raw_name, str) else ''
        if not name:
            raise ValueError('Pack name is required.')
        row.name = name
    if 'shared' in data:
        row.shared = bool(data.get('shared'))
    if 'showNames' in data:
        row.show_names = bool(data.get('showNames'))
    if 'shapes' in data:
        row.shapes = normalize_pack_shapes(data.get('shapes'))
    elif 'addShapes' in data:
        existing = row.shapes if isinstance(row.shapes, list) else []
        added = data.get('addShapes')
        if not isinstance(added, list):
            raise ValueError('addShapes must be a list.')
        row.shapes = normalize_pack_shapes([*existing, *added])
    row.updated_at = now_ms()
    row.save(update_fields=['name', 'shared', 'show_names', 'shapes', 'updated_at'])
    return _pack_dict(row, user)


def delete_shape_pack(user, identifier):
    from . import access
    row = CustomShapePack.objects.filter(pk=identifier).first()
    if row is None:
        return False
    if str(row.created_by) != str(user.id) and getattr(user, 'role', None) != 'admin':
        raise access.AccessError('Only the pack owner can delete this shape pack.', 403)
    row.delete()
    return True

