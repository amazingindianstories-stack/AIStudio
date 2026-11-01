"""Plan limits for one board: how many objects it holds and how much text one object carries.

The 2 Mi board JSON limit (serialization.MAX_BOARD_JSON_UNITS) still applies on top. Miro's numbers are a
reference; these are sized for Veevee's DOM renderer with viewport culling. A limit only refuses a save that
makes the board or the object worse than the saved one, so a board or an object already past a limit can
still be edited and trimmed. `message` is shown to the artist as written."""
from .serialization import utf16_length

MAX_BOARD_OBJECTS = 5000
# Text units (UTF-16) per object type; a type missing here is bounded only by the board size.
MAX_TEXT_UNITS = {'sticky': 3000, 'text': 20000, 'rect': 3000, 'ellipse': 3000, 'triangle': 3000,
                  'diamond': 3000, 'shape': 3000}
MAX_STICKY_TAGS = 8  # enforced where tags are normalized (serialization.MAX_NODE_TAGS)


class BoardLimitExceeded(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _nodes(state):
    nodes = state.get('nodes') if isinstance(state, dict) else None
    return nodes if isinstance(nodes, list) else []


def enforce(stored, data):
    """Raise BoardLimitExceeded when `data` (a normalized graph) grows past a limit over `stored`."""
    stored_nodes = _nodes(stored)
    nodes = _nodes(data)
    if len(nodes) > MAX_BOARD_OBJECTS and len(nodes) > len(stored_nodes):
        raise BoardLimitExceeded(
            'objects', f'A board holds up to {MAX_BOARD_OBJECTS:,} objects. Delete some objects or move them to another board.')
    before = {item.get('id'): item for item in stored_nodes if isinstance(item, dict)}
    for item in nodes:
        limit = MAX_TEXT_UNITS.get(item.get('type'))
        text = item.get('text')
        if limit is None or not isinstance(text, str) or utf16_length(text) <= limit:
            continue
        old = before.get(item.get('id'))
        if old is not None and utf16_length(old.get('text') or '') >= utf16_length(text):
            continue
        raise BoardLimitExceeded(
            'text', f'A {item["type"]} holds up to {limit:,} characters. Shorten the text or split it across objects.')
