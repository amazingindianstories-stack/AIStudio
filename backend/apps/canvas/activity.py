"""The server-side save diff: who added, edited and deleted which board objects, and when.

A graph save is compared with the graph it replaces, per node and connector id, in the save's own
transaction. The server stamps every changed object with its author and time, so a client cannot
forge them, and appends one `board_activity` row per change. Moves are not changes (as in Miro):
a node whose only difference is its position, frame or group, or a connector whose only difference
is where a free end sits, keeps its stamps and records nothing.
"""
from .models import BoardActivity
from .serialization import STAMP_KEYS

# Arrangement, not content: changing only these is a move.
ARRANGEMENT_KEYS = ('x', 'y', 'parentId', 'groupId')
SNIPPET_LENGTH = 120
# History rows are kept this long (Miro keeps 90 days); run_scheduler prunes older ones.
ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000


def _items(graph, key):
    items = graph.get(key) if isinstance(graph, dict) else None
    if not isinstance(items, list):
        return {}
    return {item['id']: item for item in items if isinstance(item, dict) and isinstance(item.get('id'), str)}


def _content(item, connector):
    content = {key: value for key, value in item.items() if key not in STAMP_KEYS}
    if connector:
        for end in ('from', 'to'):
            if isinstance(content.get(end), dict) and 'nodeId' not in content[end]:
                content[end] = 'point'
        return content
    return {key: value for key, value in content.items() if key not in ARRANGEMENT_KEYS}


def snippet(item):
    """A short plain-text label for the History panel: the object's text, frame name or image alt text."""
    if not isinstance(item, dict):
        return None
    text = item.get('name') if item.get('type') == 'frame' else item.get('alt') if item.get('type') == 'image' else item.get('text')
    if not isinstance(text, str):
        return None
    text = ' '.join(text.split())
    return text[:SNIPPET_LENGTH] or None


def _stamped(items, previous, kind, actor, now, changes):
    connector = kind == 'connector'
    result = []
    for item in items:
        old = previous.get(item['id'])
        if old is None:
            stamps = {'createdBy': actor, 'createdAt': now, 'updatedBy': actor, 'updatedAt': now}
            changes.append(('add', item, kind))
        elif _content(old, connector) != _content(item, connector):
            stamps = {key: old[key] for key in ('createdBy', 'createdAt') if key in old}
            stamps.update(updatedBy=actor, updatedAt=now)
            changes.append(('edit', item, kind))
        else:
            stamps = {key: old[key] for key in STAMP_KEYS if key in old}
        result.append({**{key: value for key, value in item.items() if key not in STAMP_KEYS}, **stamps})
    return result


def stamp(old_graph, new_graph, actor, now):
    """`new_graph` (already normalized) with server stamps, and its changes against `old_graph` as
    (action, item, kind) in graph order, deletions last. Stamps a client sent are ignored: an unchanged
    object keeps the stamps the server holds, a changed one gets `actor` and `now`."""
    changes = []
    old_nodes, old_connectors = _items(old_graph, 'nodes'), _items(old_graph, 'connectors')
    nodes = _stamped(new_graph['nodes'], old_nodes, 'node', actor, now, changes)
    connectors = _stamped(new_graph['connectors'], old_connectors, 'connector', actor, now, changes)
    kept_nodes, kept_connectors = {item['id'] for item in nodes}, {item['id'] for item in connectors}
    changes += [('delete', item, 'node') for key, item in old_nodes.items() if key not in kept_nodes]
    changes += [('delete', item, 'connector') for key, item in old_connectors.items() if key not in kept_connectors]
    return {**new_graph, 'nodes': nodes, 'connectors': connectors}, changes


def stamps_of(graph, changes):
    """The stamps a save gave the objects it added or edited, keyed by id, for the saving editor."""
    changed = {item['id'] for action, item, _ in changes if action != 'delete'}
    return {item['id']: {key: item[key] for key in STAMP_KEYS if key in item}
            for item in graph['nodes'] + graph['connectors'] if item['id'] in changed}


def record(board_id, actor, now, changes):
    BoardActivity.objects.bulk_create([
        BoardActivity(board_id=board_id, actor_id=actor, action=action, node_id=item['id'],
                      node_type=item.get('type') if kind == 'node' and isinstance(item.get('type'), str) else kind,
                      snippet=snippet(item) if kind == 'node' else None, created_at=now, ordinal=position)
        for position, (action, item, kind) in enumerate(changes)], batch_size=1000)
