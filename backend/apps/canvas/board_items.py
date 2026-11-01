"""Item-level reads and writes of one board, for the board REST API and the MCP board tools.

An item is a node or a connector exactly as the board stores it (apps.canvas.serialization). Every write is a
patch (apps.canvas.patch) applied over the version just read and saved through `services.save_board`, so
normalization, server stamps, activity history, locks, the size limit and the role rules are the editor's. When
another save lands in between, the write is rebuilt over the new version (RETRIES times) instead of failing.
"""
import re
import uuid

from . import access, services
from .serialization import connector as valid_connector, node as valid_node, validate_state

RETRIES = 5
MAX_PAGE = 200
DEFAULT_PAGE = 100
UUID_PATTERN = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
KINDS = {'items': 'nodes', 'connectors': 'connectors'}


class ItemError(Exception):
    """A refusal with a stable code (INVALID_ITEM, ITEM_NOT_FOUND, BOARD_BUSY, BOARD_TOO_LARGE, BOARD_NOT_FOUND)."""
    status = 400

    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code, self.message = code, message
        if status:
            self.status = status


def not_found(kind):
    return ItemError('ITEM_NOT_FOUND', f'No such {"connector" if kind == "connectors" else "item"} on this board.', 404)


def require_board(user, identifier, needed):
    """The user's effective level on the board, which must reach `needed` (access.READ or access.WRITE);
    a board the user cannot see is the same 404 as one that does not exist."""
    row = access.board_row(identifier) if UUID_PATTERN.fullmatch(identifier) else None
    if row is None:
        raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
    try:
        return access.require(user, row, needed)
    except access.AccessError as error:
        if error.status == 404:
            raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404) from None
        raise ItemError('FORBIDDEN', 'Your role on this board does not allow this.', 403) from None


def summary(identifier):
    """The board row without its graph, plus how many objects it holds."""
    board = services.get_board(identifier)
    if board is None:
        raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
    graph = validate_state(board['data'])
    return {**{key: value for key, value in board.items() if key != 'data'},
            'itemCount': len(graph['nodes']), 'connectorCount': len(graph['connectors'])}


def page(identifier, kind, *, type=None, cursor=0, limit=DEFAULT_PAGE):
    """A page of one kind in board (z) order. `cursor` is an offset into the filtered list at the version returned."""
    board = services.get_board(identifier)
    if board is None:
        raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
    graph = validate_state(board['data'])
    found = [item for item in graph[KINDS[kind]] if type is None or item.get('type', item.get('kind')) == type]
    limit = max(1, min(limit, MAX_PAGE))
    chunk = found[cursor:cursor + limit]
    end = cursor + len(chunk)
    return {'version': board['version'], 'items': chunk, 'total': len(found),
            'nextCursor': str(end) if end < len(found) else None}


def get(identifier, kind, item_id):
    board = services.get_board(identifier)
    if board is None:
        raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
    graph = validate_state(board['data'])
    for item in graph[KINDS[kind]]:
        if item['id'] == item_id:
            return {'version': board['version'], 'item': item}
    raise not_found(kind)


def _write(identifier, actor, level, build):
    """Run `build(graph)` -> (patch, outcome) over the stored graph and save it, retrying on a version conflict.
    Returns `(outcome, saved)`; `saved` carries `board` (the graph as stored) when a lock corrected the save."""
    for _ in range(RETRIES):
        board = services.get_board(identifier)
        if board is None:
            raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
        patch, outcome = build(validate_state(board['data']))
        try:
            saved = services.save_board(identifier, None, board['version'], str(uuid.uuid4()), actor, patch=patch, level=level)
        except services.VersionConflict:
            continue
        except services.BoardTooLarge:
            raise ItemError('BOARD_TOO_LARGE', 'The board is at its size limit.', 413) from None
        if saved is None:
            raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
        return outcome, saved
    raise ItemError('BOARD_BUSY', 'The board is being saved by others. Try again.', 409)


def _stored(saved, graph, kind, ids):
    """The items with these ids as saved: from the graph a lock correction returned, else from the one built."""
    source = saved['board'] if 'board' in saved else graph
    by_id = {item['id']: item for item in source[KINDS[kind]]}
    return [by_id[value] for value in ids if value in by_id]


def create(identifier, actor, level, kind, raws):
    """Add one or more items. Ids the caller sends are kept (a duplicate is refused); others are assigned.
    Nodes are checked first, so a connector in the same call may join them. Returns the items as stored."""
    if not raws:
        raise ItemError('INVALID_ITEM', 'Send at least one item.')

    def build(graph):
        taken = {item['id'] for item in graph[KINDS[kind]]}
        fresh = []
        for raw in raws:
            if not isinstance(raw, dict):
                raise ItemError('INVALID_ITEM', 'Each item must be an object.')
            item_id = raw.get('id') or str(uuid.uuid4())
            if not isinstance(item_id, str) or item_id in taken:
                raise ItemError('INVALID_ITEM', f'The id {item_id} is already used on this board.' if isinstance(item_id, str)
                                else 'An item id must be a string.', 409 if isinstance(item_id, str) else None)
            taken.add(item_id)
            fresh.append({**raw, 'id': item_id})
        node_ids = {item['id'] for item in graph['nodes']} | (set(taken) if kind == 'items' else set())
        checked = [valid_node(raw) if kind == 'items' else valid_connector(raw, node_ids) for raw in fresh]
        if any(item is None for item in checked):
            raise ItemError('INVALID_ITEM', 'An item is missing a required field or has an unsupported type or value. '
                                            'Items use the same fields as the board JSON.')
        ids = [item['id'] for item in checked]
        key = KINDS[kind]
        return {key: {'upsert': checked, 'add': ids}}, (ids, {**graph, key: graph[key] + checked})

    (ids, built), saved = _write(identifier, actor, level, build)
    return _stored(saved, built, kind, ids), saved['version']


def update(identifier, actor, level, kind, item_id, fields):
    """Change fields of one item: a value replaces the field, null removes it. The id and node type cannot change."""
    if not isinstance(fields, dict) or not fields:
        raise ItemError('INVALID_ITEM', 'Send the fields to change.')
    if 'id' in fields and fields['id'] != item_id or ('type' in fields and kind == 'items'):
        raise ItemError('INVALID_ITEM', 'The id and the type of an item cannot be changed.')

    def build(graph):
        current = next((item for item in graph[KINDS[kind]] if item['id'] == item_id), None)
        if current is None:
            raise not_found(kind)
        merged = {**current, **{key: value for key, value in fields.items() if value is not None}}
        for key, value in fields.items():
            if value is None:
                merged.pop(key, None)
        node_ids = {item['id'] for item in graph['nodes']}
        checked = valid_node(merged) if kind == 'items' else valid_connector(merged, node_ids)
        if checked is None:
            raise ItemError('INVALID_ITEM', 'The change leaves the item invalid. Items use the same fields as the board JSON.')
        key = KINDS[kind]
        replaced = [checked if item['id'] == item_id else item for item in graph[key]]
        return {key: {'upsert': [checked]}}, {**graph, key: replaced}

    built, saved = _write(identifier, actor, level, build)
    stored = _stored(saved, built, kind, [item_id])
    return (stored[0] if stored else None), saved['version']


def delete(identifier, actor, level, kind, item_id):
    """Remove one item; connectors that ended on a removed node go with it. Returns the new version."""
    def build(graph):
        if not any(item['id'] == item_id for item in graph[KINDS[kind]]):
            raise not_found(kind)
        return {KINDS[kind]: {'delete': [item_id]}}, None

    _, saved = _write(identifier, actor, level, build)
    return saved['version']


def changes(identifier, since):
    """The polled change feed: the objects changed since board version `since`, or the whole graph when too far back."""
    found = services.board_changes(identifier, since)
    if found is None:
        raise ItemError('BOARD_NOT_FOUND', 'Board not found.', 404)
    return found
