"""Per-object board saves and reads, mirrored by src/lib/canvas/patch.js.

A patch is a save sent as the difference from the version it starts from: for nodes and for connectors the
items added or changed (`upsert`, whole items), the ids of the upserted items that are new (`add`) and the ids
deleted (`delete`), plus the full id order only when the order is not "the kept items in their old order, then
the added ones in patch order". A patch whose `add` does not name exactly the upserted items the stored graph
lacks was built over a different graph (the editor held back an image someone deleted while it was cropped):
it is refused, so the editor sends its whole graph and no item lands at a z-position it did not choose. The server
rebuilds the whole graph from the stored one and saves it exactly as a full save (apps.canvas.services), so
normalization, stamps, History and the size limit all see the resulting whole board.

Each version a save makes records the ids of the objects it changed in any way (moves included), so an open
board that is a few versions behind can fetch only those objects (`changes_since`).
"""
KINDS = ('nodes', 'connectors')
ORDER_KEYS = {'nodes': 'nodeOrder', 'connectors': 'connectorOrder'}
# A save that changed more objects than this records no ids; boards that missed it fetch the whole graph.
MAX_RECORDED_IDS = 2000
# Boards further behind than this many versions fetch the whole graph.
MAX_CHANGE_VERSIONS = 200


class PatchError(ValueError):
    """A patch that does not describe a graph: the editor sends its whole graph instead."""


def _identifier(value):
    if not isinstance(value, str) or not value:
        raise PatchError()
    return value


def _section(patch, kind):
    section = patch.get(kind, {})
    if not isinstance(section, dict):
        raise PatchError()
    upsert, add, delete = section.get('upsert', []), section.get('add', []), section.get('delete', [])
    if not isinstance(upsert, list) or not isinstance(add, list) or not isinstance(delete, list):
        raise PatchError()
    items = {}
    for item in upsert:
        if not isinstance(item, dict) or _identifier(item.get('id')) in items:
            raise PatchError()
        items[item['id']] = item
    return items, {_identifier(value) for value in add}, {_identifier(value) for value in delete}


def _applied(stored, items, added, deleted, order):
    kept = [items.pop(item['id'], item) for item in stored if item['id'] not in deleted]
    if set(items) != added:
        raise PatchError()
    result = kept + list(items.values())
    if order is None:
        return result
    if not isinstance(order, list) or len(order) != len(result):
        raise PatchError()
    by_id = {item['id']: item for item in result}
    if len(by_id) != len(result) or {_identifier(value) for value in order} != set(by_id):
        raise PatchError()
    return [by_id[value] for value in order]


def apply_patch(stored, patch):
    """The whole graph `patch` makes of the `stored` (normalized) graph, not yet normalized itself."""
    if not isinstance(patch, dict):
        raise PatchError()
    graph = dict(stored)
    for kind in KINDS:
        items, added, deleted = _section(patch, kind)
        graph[kind] = _applied(stored[kind], items, added, deleted, patch.get(ORDER_KEYS[kind]))
    if 'viewport' in patch:
        graph['viewport'] = patch['viewport']
    return graph


def changed_ids(old_graph, new_graph):
    """The ids of the nodes and of the connectors that differ in any way (added, deleted, moved, edited)
    between two normalized graphs, or None when there are more than MAX_RECORDED_IDS."""
    result = {}
    for kind in KINDS:
        old = {item['id']: item for item in old_graph[kind]}
        new = {item['id']: item for item in new_graph[kind]}
        result[kind] = sorted([key for key, item in new.items() if old.get(key) != item] +
                              [key for key in old if key not in new])
    return None if sum(len(ids) for ids in result.values()) > MAX_RECORDED_IDS else result


def order_hash(ids):
    """FNV-1a (32 bit) over the ids' UTF-16 code units, each id followed by a newline; the client computes the
    same over the graph it rebuilt, and fetches the whole graph when they differ."""
    value = 0x811c9dc5
    for identifier in ids:
        encoded = (identifier + '\n').encode('utf-16-le', 'surrogatepass')
        for index in range(0, len(encoded), 2):
            value = ((value ^ (encoded[index] | encoded[index + 1] << 8)) * 0x01000193) & 0xffffffff
    return value


def changes_since(graph, records):
    """What changed in `graph` (the current normalized graph) across `records`, the change records of every
    version after the one the editor holds: the current items with those ids, the ids no longer on the board,
    and a hash of each kind's full order. None when a record is missing ids."""
    if any(record is None for record in records):
        return None
    result = {}
    for kind in KINDS:
        ids = set().union(*(record.get(kind, ()) for record in records))
        items = [item for item in graph[kind] if item['id'] in ids]
        present = {item['id'] for item in items}
        result[kind] = {'upsert': items, 'delete': sorted(ids - present)}
    result['nodeOrderHash'] = order_hash(item['id'] for item in graph['nodes'])
    result['connectorOrderHash'] = order_hash(item['id'] for item in graph['connectors'])
    return result
