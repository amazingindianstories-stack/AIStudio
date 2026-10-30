"""Synced copies: view-only references to a frame on another board.

A `synced` node on a board stores only which board and which frame it points at. The editor asks for the frame's
current content when the node is shown and again while it stays on screen; nothing is pushed and nothing of
the source is copied into the copy's board. Each read checks the caller's own access to the *source* board and
applies the same hidden-frame rule as reading that board directly, so a copy never shows what its viewer
could not open the source and see.
"""
import re

from . import access, hidden
from .models import CanvasBoard
from .serialization import validate_state
from .views import failure, node_route, reply
from apps.authentication.session import lookup

ID_PATTERN = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
NODE_ID_PATTERN = re.compile(r'[^\x00-\x1f/]{1,64}')


def _readable_graph(user, identifier):
    """The source board's row and its graph as the caller may read it, or (None, None) when they may not open it."""
    if not ID_PATTERN.fullmatch(identifier):
        return None, None, None
    existing = access.board_row(identifier)
    if existing is None or access.role_for(user, existing) < access.READ:
        return None, None, None
    level = access.role_for(user, existing)
    row = CanvasBoard.objects.filter(pk=identifier).values('name', 'version', 'data', 'project_id').first()
    return row, hidden.view_of(validate_state(row['data']), level), level


def frame_summaries(graph, level):
    """The frames a caller can sync: visible frames of the board, never hidden ones for people who cannot manage them."""
    return [{'id': item['id'], 'name': item.get('name', 'Frame'), 'w': item['w'], 'h': item['h'], 'parentId': item.get('parentId')}
            for item in graph['nodes'] if item.get('type') == 'frame' and (hidden.can_manage(level) or not item.get('hidden'))]


def frame_content(graph, level, node_id):
    """A frame with everything inside it (at any depth) and the connectors among those objects; None when absent or hidden from the caller."""
    frame = next((item for item in graph['nodes'] if item['id'] == node_id and item.get('type') == 'frame'), None)
    if frame is None or (frame.get('hidden') and not hidden.can_manage(level)):
        return None
    children, queue, inside = {}, [node_id], {node_id}
    for item in graph['nodes']:
        if item.get('parentId'):
            children.setdefault(item['parentId'], []).append(item['id'])
    while queue:
        for child in children.get(queue.pop(), ()):
            if child not in inside:
                inside.add(child)
                queue.append(child)
    nodes = [item for item in graph['nodes'] if item['id'] in inside]
    connectors = [item for item in graph['connectors']
                  if all(not isinstance(item.get(end), dict) or item[end].get('nodeId') is None or item[end]['nodeId'] in inside
                         for end in ('from', 'to')) and any(isinstance(item.get(end), dict) and item[end].get('nodeId') in inside for end in ('from', 'to'))]
    return {'frame': frame, 'nodes': nodes, 'connectors': connectors}


@node_route(['GET'])
def board_frames(request, identifier):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        row, graph, level = _readable_graph(user, identifier)
        if row is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        return reply(request, {'board': {'id': identifier, 'name': row['name'], 'projectId': str(row['project_id']) if row['project_id'] else None}, 'frames': frame_summaries(graph, level)})
    except Exception:
        return failure()


@node_route(['GET'])
def board_frame(request, identifier, node_id):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        row, graph, level = _readable_graph(user, identifier)
        content = frame_content(graph, level, node_id) if row is not None and NODE_ID_PATTERN.fullmatch(node_id) else None
        if content is None:
            return reply(request, {'error': 'Frame not found.'}, 404)
        return reply(request, {'board': {'id': identifier, 'name': row['name'], 'projectId': str(row['project_id']) if row['project_id'] else None}, 'version': row['version'], **content})
    except Exception:
        return failure()


@node_route(['GET'])
def frame_copies(request, identifier, node_id):
    """Boards the caller can open that hold a synced copy of this frame."""
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        row, graph, level = _readable_graph(user, identifier)
        if row is None or not NODE_ID_PATTERN.fullmatch(node_id):
            return reply(request, {'error': 'Frame not found.'}, 404)
        marker = [{'type': 'synced', 'sourceBoardId': identifier, 'sourceNodeId': node_id}]
        rows = list(CanvasBoard.objects.filter(data__nodes__contains=marker)
                    .values('id', 'project_id', 'created_by', 'team_role', 'name', 'data')[:200])
        levels = access.roles_for(user, rows)
        copies = []
        for entry in rows:
            if levels[str(entry['id'])] < access.READ:
                continue
            nodes = validate_state(entry['data'])['nodes']
            for item in nodes:
                if item.get('type') == 'synced' and item['sourceBoardId'] == identifier and item['sourceNodeId'] == node_id:
                    copies.append({'boardId': str(entry['id']), 'boardName': entry['name'], 'nodeId': item['id']})
        return reply(request, {'copies': copies})
    except Exception:
        return failure()
