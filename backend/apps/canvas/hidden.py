"""Hidden frames: an owner hides a frame so nobody else sees its content until it is revealed.

Every client receives the whole board graph, so hiding is enforced here, on the server. A hidden frame is a
frame node with `hidden: true`. For a viewer who may not manage hidden frames (anyone below co-owner), the
frame itself stays on the board as an empty placeholder while everything inside it, at any depth, and every
connector touching that content, is removed from what they read (`view_of`). When that viewer saves, what
they never saw is kept exactly as stored and the `hidden` flags cannot change (`preserve`), so a normal
save from a person who cannot see it never deletes or exposes hidden work. People who manage hidden frames
(`can_manage`) read and save the whole graph. Links from the board's visual notes to hidden objects are
treated the same way, and a link to a deleted object reaches them without its label.
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


def _with_refs(notes, refs):
    result = {key: value for key, value in notes.items() if key != 'refs'}
    if refs:
        result['refs'] = refs
    return result


def view_of(graph, level):
    """What a viewer at `level` may read of `graph`."""
    if can_manage(level):
        return graph
    gone = hidden_ids(graph)
    gone |= {item['id'] for item in graph['connectors'] if _touches(item, gone)}
    seen = {**graph,
            'nodes': [item for item in graph['nodes'] if item['id'] not in gone],
            'connectors': [item for item in graph['connectors'] if item['id'] not in gone]}
    notes = graph.get('notes')
    if notes and notes.get('refs'):
        # A link to an object no longer on the board keeps its place but not its label, which may describe
        # something that was hidden from this viewer when it was deleted.
        on_board = {item['id'] for item in graph['nodes'] + graph['connectors']}
        seen['notes'] = _with_refs(notes, [ref if ref['id'] in on_board else {**ref, 'label': ''}
                                           for ref in notes['refs'] if ref['id'] not in gone])
    return seen


def visible_data(raw, level):
    """A stored board's `data` as someone at `level` reads it: untouched unless it holds a hidden frame or notes links."""
    from .serialization import validate_state
    nodes = raw.get('nodes') if isinstance(raw, dict) else None
    if can_manage(level) or not isinstance(nodes, list):
        return raw
    notes = raw.get('notes')
    if not (isinstance(notes, dict) and notes.get('refs')) and not any(
            isinstance(item, dict) and item.get('type') == 'frame' and item.get('hidden') is True for item in nodes):
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
    if can_manage(level):
        return incoming
    result, unseen = incoming, set()
    if has_hidden(stored) or any(item.get('hidden') for item in incoming['nodes']):
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
        result = {**incoming, 'nodes': nodes, 'connectors': connectors}
        unseen = inside | set(connector_protected)
    # Links they never read (to hidden objects) stay, and links they read without a label keep the stored one.
    notes = result.get('notes')
    stored_refs = (stored.get('notes') or {}).get('refs', [])
    ref_protected = {ref['id']: ref for ref in stored_refs if ref['id'] in unseen}
    if notes or ref_protected:
        on_board = {item['id'] for item in stored['nodes'] + stored['connectors']}
        unlabeled = {ref['id']: ref for ref in stored_refs if ref['id'] not in on_board}
        refs = [unlabeled.get(ref['id'], ref) for ref in (notes or {}).get('refs', []) if ref['id'] not in unseen]
        result = {**result, 'notes': _with_refs(notes or {'text': ''}, _merged(stored_refs, refs, ref_protected))}
    return result
