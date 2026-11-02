"""Large format payloads (Docs blocks, HTML embeds, draw.io XML and previews) kept outside the board JSON.

Each lives in its own row keyed by board and node (`BoardFormatPayload`); the board node keeps `payload`, a
`{size, rev}` reference. An editor loads the rows it needs on demand (`GET .../payloads/<node>`), so a board
never needs every payload to render. A save carries a node's fields only when they changed: `split` runs
inside `save_board`, under the board lock, takes the payload fields off the validated graph and returns the
rows to write, `write` applies them once the graph has settled. A node saved with its reference but without
the fields (its payload was not loaded or did not change) keeps the stored row, and the save's stamps give
the saving editor each changed node's new reference. Every other reader gets the inline shape back from `hydrate`, which
is also how a board not yet migrated (payload fields still inline, no reference) is read."""
import hashlib
import json
from .formats import PAYLOAD_FIELDS, PAYLOAD_PROBE
from .models import BoardFormatPayload
from .serialization import utf16_length

# One payload's JSON, in UTF-16 units. Over it the save is refused (413); the per-field caps in formats.py
# (500,000 characters each, 2,000 blocks of 20,000) are tighter for a single field, this bounds the sum.
MAX_PAYLOAD_UNITS = 1024 * 1024


class PayloadTooLarge(Exception):
    def __init__(self, node_id, size):
        super().__init__(f'Payload of {node_id} is {size} units.')
        self.node_id = node_id
        self.size = size


def body_of(node):
    """The payload fields of a validated format node as the stored body; None when the node holds none."""
    kind = node.get('format')
    if kind not in PAYLOAD_PROBE or PAYLOAD_PROBE[kind] not in node:
        return None
    if kind == 'doc':
        return {'blocks': node['blocks'], 'suggestions': node.get('suggestions', [])}
    if kind == 'html':
        return {'html': node['html']}
    return {'xml': node['xml'], 'preview': node.get('preview', '')}


def digest_of(body):
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8', 'surrogatepass')).hexdigest()


def size_of(body):
    return utf16_length(json.dumps(body, separators=(',', ':'), ensure_ascii=False))


def restore(node, body):
    """The payload fields back on a node, in the shape validation produces (empty suggestions and preview omitted)."""
    kind = node.get('format')
    if kind == 'doc':
        node['blocks'] = body.get('blocks', [])
        if body.get('suggestions'):
            node['suggestions'] = body['suggestions']
    elif kind == 'html':
        node['html'] = body.get('html', '')
    else:
        node['xml'] = body.get('xml', '')
        if body.get('preview'):
            node['preview'] = body['preview']


def _format_nodes(data):
    nodes = data.get('nodes') if isinstance(data, dict) else None
    return [node for node in nodes if isinstance(node, dict) and node.get('type') == 'format' and node.get('format') in PAYLOAD_FIELDS] \
        if isinstance(nodes, list) else []


def slim_length(data):
    """The size of a raw (not yet validated) graph as the board JSON will be once its payload fields move to
    rows: the early size gate in the save view measures this, so Docs and diagrams do not count against 2 Mi."""
    from .serialization import content_length
    nodes = data.get('nodes') if isinstance(data, dict) else None
    if not isinstance(nodes, list):
        return content_length(data)
    slim = [{key: value for key, value in node.items() if key not in PAYLOAD_FIELDS[node['format']]}
            if isinstance(node, dict) and node.get('type') == 'format' and isinstance(node.get('format'), str) and node['format'] in PAYLOAD_FIELDS else node
            for node in nodes]
    return content_length({**data, 'nodes': slim})


def oversized(data):
    """The id of the first format node of the validated graph `data` whose inline payload is over MAX_PAYLOAD_UNITS, or None."""
    for node in _format_nodes(data):
        body = body_of(node)
        if body is not None and size_of(body) > MAX_PAYLOAD_UNITS:
            return node['id']
    return None


def split(board_id, data):
    """Take the payload fields off the validated graph `data` (in place) and give each such node its reference.
    Returns {node id: (kind, body, digest, size, rev)} for the rows whose content changed. A reference without
    row behind it is dropped; one that is stale is brought up to date."""
    nodes = _format_nodes(data)
    if not nodes:
        return {}
    rows = {row['node_id']: row for row in BoardFormatPayload.objects.filter(
        board_id=board_id, node_id__in=[node['id'] for node in nodes]).values('node_id', 'digest', 'size', 'rev')}
    writes = {}
    for node in nodes:
        body, row = body_of(node), rows.get(node['id'])
        if body is None:
            if row is None:
                node.pop('payload', None)
            else:
                node['payload'] = {'size': row['size'], 'rev': row['rev']}
            continue
        for field in PAYLOAD_FIELDS[node['format']]:
            node.pop(field, None)
        digest, size = digest_of(body), size_of(body)
        if size > MAX_PAYLOAD_UNITS:
            raise PayloadTooLarge(node['id'], size)
        if row is not None and row['digest'] == digest:
            rev = row['rev']
        else:
            rev = row['rev'] + 1 if row is not None else 1
            writes[node['id']] = (node['format'], body, digest, size, rev)
        node['payload'] = {'size': size, 'rev': rev}
    return writes


def write(board_id, writes, data, actor, now):
    """Store the rows `split` returned that the settled graph `data` still refers to at that revision (a change
    the save then put back, such as a locked object's, is not written). A row outlives its node: an undo or a
    merge that brings the node back with only its reference finds the payload. The rows go with the board."""
    final = {node['id']: node for node in _format_nodes(data)}
    for node_id, (kind, body, digest, size, rev) in writes.items():
        node = final.get(node_id)
        if node is None or (node.get('payload') or {}).get('rev') != rev:
            continue
        BoardFormatPayload.objects.update_or_create(board_id=board_id, node_id=node_id, defaults={
            'kind': kind, 'body': body, 'digest': digest, 'size': size, 'rev': rev,
            'updated_by': actor, 'updated_at': now})


def read(board_id, node_ids):
    """{node id: row dict} of the payloads of `node_ids`."""
    return {row['node_id']: row for row in BoardFormatPayload.objects.filter(board_id=board_id, node_id__in=list(node_ids)).values(
        'node_id', 'kind', 'body', 'size', 'rev')}


def _unloaded(node):
    return node.get('type') == 'format' and isinstance(node.get('format'), str) and node['format'] in PAYLOAD_FIELDS and 'payload' in node and PAYLOAD_PROBE[node['format']] not in node


def hydrate(board_id, data):
    """A copy of the graph `data` with every referenced payload put back inline and the references removed: the
    shape of a board before payloads had their own rows. A node whose row is missing gets empty fields."""
    nodes = data.get('nodes') if isinstance(data, dict) else None
    if not isinstance(nodes, list) or not any(isinstance(node, dict) and _unloaded(node) for node in nodes):
        return data
    rows = read(board_id, [node['id'] for node in nodes if isinstance(node, dict) and _unloaded(node)])
    filled = []
    for node in nodes:
        if isinstance(node, dict) and _unloaded(node):
            node = {key: value for key, value in node.items() if key != 'payload'}
            restore(node, rows[node['id']]['body'] if node['id'] in rows else {})
        filled.append(node)
    return {**data, 'nodes': filled}


def fill_from(data, source):
    """A copy of the raw graph `data` (part of a board, sent by an editor) whose unloaded format nodes take their
    payload fields from the same node of the inline graph `source`, that board as its reader sees it. A node
    `source` does not hold gets empty fields."""
    nodes = data.get('nodes') if isinstance(data, dict) else None
    if not isinstance(nodes, list) or not any(isinstance(node, dict) and _unloaded(node) for node in nodes):
        return data
    known = {node['id']: node for node in _format_nodes(source)}
    filled = []
    for node in nodes:
        if isinstance(node, dict) and _unloaded(node):
            same = known.get(node['id'])
            node = {key: value for key, value in node.items() if key != 'payload'}
            restore(node, (body_of(same) if same and same['format'] == node['format'] else None) or {})
        filled.append(node)
    return {**data, 'nodes': filled}
