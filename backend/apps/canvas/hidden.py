"""Hidden frames: an owner hides a frame so nobody else sees its content until it is revealed.

Every client receives the whole board graph, so hiding is enforced here, on the server. A hidden frame is a
frame node with `hidden: true`. For a viewer who may not manage hidden frames (anyone below co-owner), the
frame itself stays on the board as an empty placeholder while everything inside it, at any depth, and every
connector touching that content, is removed from what they read (`view_of`). When that viewer saves, what
they never saw is kept exactly as stored and the `hidden` flags cannot change (`preserve`), so a normal
save from a person who cannot see it never deletes or exposes hidden work. People who manage hidden frames
(`can_manage`) read and save the whole graph.
"""
from . import access


def can_manage(level):
    """Co-owners and owners hide, reveal and see hidden content."""
    return level >= access.CO_OWNER


def _children(nodes):
    result = {}
    for item in nodes:
        parent = item.get('parentId')
        if parent:
            result.setdefault(parent, []).append(item['id'])
    return result


def hidden_frame_ids(graph):
    return {item['id'] for item in graph.get('nodes', []) if item.get('type') == 'frame' and item.get('hidden') is True}


def hidden_ids(graph):
    """Ids of everything inside a hidden frame, at any depth (the hidden frames themselves excluded)."""
    nodes = graph.get('nodes', [])
    children = _children(nodes)
    result, queue = set(), list(hidden_frame_ids(graph))
    while queue:
        for child in children.get(queue.pop(), ()):
            if child not in result:
                result.add(child)
                queue.append(child)
    return result


def has_hidden(graph):
    return bool(hidden_frame_ids(graph))


def _touches(connector, ids):
    return any(isinstance(connector.get(end), dict) and connector[end].get('nodeId') in ids for end in ('from', 'to'))


def view_of(graph, level):
    """What a viewer at `level` may read of `graph`."""
    if can_manage(level) or not has_hidden(graph):
        return graph
    gone = hidden_ids(graph)
    return {**graph,
            'nodes': [item for item in graph['nodes'] if item['id'] not in gone],
            'connectors': [item for item in graph['connectors'] if not _touches(item, gone)]}


def visible_data(raw, level):
    """A stored board's `data` as someone at `level` reads it: untouched unless it holds a hidden frame they may not see into."""
    from .serialization import validate_state
    nodes = raw.get('nodes') if isinstance(raw, dict) else None
    if can_manage(level) or not isinstance(nodes, list):
        return raw
    if not any(isinstance(item, dict) and item.get('type') == 'frame' and item.get('hidden') is True for item in nodes):
        return raw
    return view_of(validate_state(raw), level)


def _merged(stored_items, kept_items, protected):
    """`kept_items` (the editor's own) with the `protected` stored items put back after the item they followed in
    stored order (the nearest one the editor still has), so z-order survives."""
    present = {item['id'] for item in kept_items}
    inserts, anchor = {}, None
    for item in stored_items:
        if item['id'] in protected:
            inserts.setdefault(anchor, []).append(protected[item['id']])
        elif item['id'] in present:
            anchor = item['id']
    result = list(inserts.get(None, []))
    for item in kept_items:
        result.append(item)
        result.extend(inserts.get(item['id'], []))
    return result


def preserve(stored, incoming, level):
    """`incoming` (a normalized graph saved by someone at `level`) with the hidden content of `stored` kept."""
    if can_manage(level) or not (has_hidden(stored) or any(item.get('hidden') for item in incoming['nodes'])):
        return incoming
    frames, inside = hidden_frame_ids(stored), hidden_ids(stored)
    protected_ids = frames | inside
    protected = {item['id']: item for item in stored['nodes'] if item['id'] in protected_ids}
    stored_flags = {item['id']: item.get('hidden') is True for item in stored['nodes'] if item.get('type') == 'frame'}
    nodes = []
    for item in incoming['nodes']:
        if item['id'] in protected_ids:
            continue
        item = dict(item)
        # Nothing can be added into a hidden frame by someone who cannot see inside it.
        if item.get('parentId') in protected_ids:
            item['parentId'] = None
        # Only people who manage hidden frames change the flag.
        if item.get('type') == 'frame' and item.get('hidden') and not stored_flags.get(item['id']):
            del item['hidden']
        nodes.append(item)
    nodes = _merged(stored['nodes'], nodes, protected)
    connector_protected = {item['id']: item for item in stored['connectors'] if _touches(item, inside)}
    connectors = [item for item in incoming['connectors'] if item['id'] not in connector_protected and not _touches(item, inside)]
    connectors = _merged(stored['connectors'], connectors, connector_protected)
    return {**incoming, 'nodes': nodes, 'connectors': connectors}
