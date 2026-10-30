"""What a save may not change, enforced on the whole graph it makes (apps.canvas.services.save_board).

A protected lock (`lockProtected`, with `lockedBy`) can only be set by a co-owner or owner, for themselves. While it
holds, only the person who set it and the board's current co-owners and owner can change, unlock or delete the
object, so a lock whose setter left the board or lost co-owner access is never stuck; plain locks guard against
accidents in the editor and anyone who can edit may lift them. The start view newly invited people open at is
chosen by co-owners and owners. A save that tries anything else keeps the rest of its changes, and the stored
objects or setting it touched are put back, so an editor that is out of date never loses unrelated work.
"""
from . import access
from .serialization import STAMP_KEYS, validate_state


def _content(item):
    return {key: value for key, value in item.items() if key not in STAMP_KEYS}


def _protected(item):
    return item.get('lockProtected') is True


def _manages(level):
    return level is not None and level >= access.CO_OWNER


def _held_by_other(item, actor, level):
    return _protected(item) and item.get('lockedBy') != actor and not _manages(level)


def _unprotected(item):
    return {key: value for key, value in item.items() if key != 'lockProtected'}


def enforce(stored, data, actor, level):
    """`data` (normalized) with the changes `actor`, at access `level`, may not make put back, and whether any
    were. `stored` is the normalized graph the save replaces."""
    corrected = False
    stored_nodes = {item['id']: item for item in stored['nodes']}
    may_protect = _manages(level)
    nodes = []
    for item in data['nodes']:
        old = stored_nodes.get(item['id'])
        if old is not None and _held_by_other(old, actor, level):
            if _content(item) != _content(old):
                item, corrected = old, True
        elif _protected(item):
            kept = old is not None and _protected(old) and old.get('lockedBy') == item.get('lockedBy')
            if not kept and not (may_protect and item.get('lockedBy') == actor):
                item, corrected = _unprotected(item), True
        nodes.append(item)
    present = {item['id'] for item in nodes}
    for index, old in enumerate(stored['nodes']):
        if old['id'] not in present and _held_by_other(old, actor, level):
            nodes.insert(min(index, len(nodes)), old)
            corrected = True
    graph = {**data, 'nodes': nodes}
    if not may_protect:
        before = (stored.get('settings') or {}).get('startView')
        settings = dict(data.get('settings') or {})
        if settings.get('startView') != before:
            if before is None:
                settings.pop('startView', None)
            else:
                settings['startView'] = before
            graph['settings'] = settings
            corrected = True
    return (validate_state(graph), True) if corrected else (data, False)
