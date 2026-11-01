"""Private mode: sticky note text only its author can read until it is revealed (area D facilitation).

The hidden text never reaches another browser: every read of a board (`services.get_board`, `board_changes`
and the 409 body) goes through `redact_graph`, which blanks the text and marks of another person's private
sticky notes and flags them `hiddenText`. Every save goes through `restore_hidden` first, which puts the stored
text back, so a client that never held the text cannot erase it by moving or resizing the note. New and edited
sticky notes are claimed by `claim` while the mode is on.

A note is `privateBy` its author. `anonBy` marks a note written while names were anonymous: its author, editor
and text attribution are withheld from everyone but the author, for good (they stay withheld after the reveal).
Revealing starts a countdown (`reveal_at`); `settle` then ends the mode and clears `privateBy` from the board
in the same kind of server write a save makes, so open boards poll the new version and show the text.
"""
import json
import uuid
from django.db import connection, transaction
from .models import BoardPrivateMode, CanvasBoard
from .serialization import validate_state

REVEAL_COUNTDOWN_MS = 5000
# What a hidden note withholds: the text, its formatting marks.
HIDDEN_FIELDS = ('text', 'marks')
# Attribution an anonymous note withholds from other people.
ATTRIBUTION_KEYS = ('createdBy', 'updatedBy', 'textBy')


def mode_row(board_id):
    return BoardPrivateMode.objects.filter(board_id=board_id).first()


def hiding(mode, now):
    """Whether sticky text written in private mode is withheld right now."""
    return bool(mode and mode.active and (mode.reveal_at is None or now < mode.reveal_at))


def writing_private(mode):
    """Whether a note saved now becomes private: the mode is on and no reveal has been called."""
    return bool(mode and mode.active and mode.reveal_at is None)


def _sticky(item):
    return isinstance(item, dict) and item.get('type') == 'sticky'


def redact_node(node, viewer, hide):
    """`node` as `viewer` may see it: the same object when there is nothing to withhold."""
    if not _sticky(node):
        return node
    viewer = str(viewer)
    private_by, anon = node.get('privateBy'), node.get('anonBy') is True
    withhold = hide and private_by is not None and private_by != viewer
    anonymise = anon and node.get('createdBy') != viewer
    if not withhold and not anonymise:
        return node
    result = dict(node)
    if withhold:
        for key in HIDDEN_FIELDS:
            result.pop(key, None)
        result['text'] = ''
        result['hiddenText'] = True
    if anonymise:
        for key in ATTRIBUTION_KEYS + ('privateBy',):
            result.pop(key, None)
        result.pop('showAuthor', None)
    return result


def redact_graph(graph, viewer, now, mode=None):
    """The board graph as `viewer` may see it. `mode` defaults to the board's row only when needed by callers
    that already hold it; pass it to avoid a second read."""
    if not isinstance(graph, dict) or not isinstance(graph.get('nodes'), list):
        return graph
    hide = hiding(mode, now)
    nodes = [redact_node(node, viewer, hide) for node in graph['nodes']]
    if all(new is old for new, old in zip(nodes, graph['nodes'])):
        return graph
    return {**graph, 'nodes': nodes}


def redact_changes(changes, viewer, now, mode=None):
    """The same for the objects a `board_changes` reply carries."""
    if not isinstance(changes, dict) or not isinstance(changes.get('nodes'), dict):
        return changes
    hide = hiding(mode, now)
    upsert = [redact_node(node, viewer, hide) for node in changes['nodes'].get('upsert', [])]
    return {**changes, 'nodes': {**changes['nodes'], 'upsert': upsert}}


def restore_hidden(stored, incoming, actor):
    """`incoming` (the graph a save would store) with the text of other people's private notes put back from
    `stored`, whatever the client sent for it. A deleted note stays deleted; arrangement and style the client
    changed are kept."""
    actor = str(actor)
    protected = {node['id']: node for node in stored.get('nodes', [])
                 if _sticky(node) and node.get('privateBy') not in (None, actor)}
    if not protected:
        return incoming
    nodes = []
    for node in incoming['nodes']:
        old = protected.get(node.get('id'))
        if old is None or not _sticky(node):
            nodes.append(node)
            continue
        restored = {key: value for key, value in node.items() if key not in HIDDEN_FIELDS and key != 'hiddenText'}
        for key in HIDDEN_FIELDS:
            if key in old:
                restored[key] = old[key]
        # The note keeps its owner; a client cannot take it over or hand it back.
        restored['privateBy'] = old['privateBy']
        if old.get('anonBy'):
            restored['anonBy'] = True
        nodes.append(restored)
    return {**incoming, 'nodes': nodes}


def _carry(stored, stamped):
    """`stamped` with the private owner and anonymity of notes it kept put back: stamping drops them from a note
    the save changed (moved, resized), but they belong to the stored note."""
    old = {node['id']: node for node in stored.get('nodes', []) if isinstance(node, dict) and 'id' in node}
    nodes = []
    for node in stamped['nodes']:
        previous = old.get(node['id'])
        if previous is not None and _sticky(node):
            kept = {key: previous[key] for key in ('privateBy', 'anonBy') if key in previous and key not in node}
            if kept:
                node = {**node, **kept}
        nodes.append(node)
    return {**stamped, 'nodes': nodes}


def claim(stored, stamped, actor, mode):
    """`stamped` (the graph after server stamping) with the sticky notes this save added or whose text it
    changed made private to `actor`, while the mode is on. Returns the graph and the ids it claimed."""
    stamped = _carry(stored, stamped)
    if not writing_private(mode):
        return stamped, set()
    actor = str(actor)
    old = {node['id']: node for node in stored.get('nodes', []) if isinstance(node, dict) and 'id' in node}
    claimed, nodes = set(), []
    for node in stamped['nodes']:
        previous = old.get(node['id'])
        fresh = previous is None
        edited = previous is not None and (previous.get('text') != node.get('text') or previous.get('marks') != node.get('marks'))
        if _sticky(node) and (fresh or edited) and not previous_private_to_other(previous, actor):
            node = {**node, 'privateBy': actor}
            if mode.anonymous:
                node['anonBy'] = True
            claimed.add(node['id'])
        nodes.append(node)
    return {**stamped, 'nodes': nodes}, claimed


def previous_private_to_other(previous, actor):
    return bool(previous and previous.get('privateBy') not in (None, actor))


def reveal_all(graph):
    """`graph` with every note public again; anonymity stays."""
    nodes = [{key: value for key, value in node.items() if key != 'privateBy'} if node.get('privateBy') is not None else node
             for node in graph['nodes']]
    return {**graph, 'nodes': nodes}


def reveal_mine(graph, actor):
    actor = str(actor)
    nodes = [{key: value for key, value in node.items() if key != 'privateBy'} if node.get('privateBy') == actor else node
             for node in graph['nodes']]
    return {**graph, 'nodes': nodes}


def write_board(board_id, now, change):
    """A server-made change to the board graph, recorded like a save so open boards poll and fetch just the
    changed notes. `change` takes the stored normalized graph and returns the new one; no History rows are
    written for it. Returns True when the graph changed."""
    from . import patch as board_patch
    from .services import _graph
    with transaction.atomic():
        row = CanvasBoard.objects.select_for_update().filter(pk=board_id).values('version', 'data').first()
        if row is None:
            return False
        stored = validate_state(row['data'])
        updated = validate_state(change(stored))
        if _graph(updated) == _graph(stored):
            return False
        version = row['version'] + 1
        CanvasBoard.objects.filter(pk=board_id).update(data=updated, updated_at=now, version=version)
        changed = board_patch.changed_ids(stored, updated)
        with connection.cursor() as cursor:
            cursor.execute('INSERT INTO canvas_board_saves (board_id, save_id, version, applied_at, changes) '
                           'VALUES (%s, %s, %s, %s, %s)',
                           [board_id, uuid.uuid4(), version, now, None if changed is None else json.dumps(changed)])
    return True


def settle(board_id, now):
    """End a mode whose reveal countdown has run out: clear `privateBy` board-wide and switch the mode off.
    Idempotent and safe to call from any reader."""
    mode = mode_row(board_id)
    if not mode or not mode.active or mode.reveal_at is None or now < mode.reveal_at:
        return mode
    write_board(board_id, now, reveal_all)
    BoardPrivateMode.objects.filter(board_id=board_id, active=True, reveal_at__lte=now).update(active=False, updated_at=now)
    return mode_row(board_id)
