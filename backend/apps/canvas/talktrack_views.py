"""Talktrack routes (area D). Watching needs view access, reacting and commenting need comment access,
recording and editing need edit access (renaming and deleting also belong to whoever recorded it)."""
from . import access, services, talktrack
from .facilitation import FacilitationError
from .facilitation_views import _data, _guarded
from .views import UUID_PATTERN, failure, node_route, reply
from apps.authentication.session import lookup


def _minimum(request, read=access.READ, write=access.WRITE):
    return read if request.method in ('GET', 'HEAD') else write


@node_route(['GET', 'POST'])
def board_talktracks(request, identifier):
    """GET lists the board's recordings; POST registers a finished upload."""
    def handle(request, user, board, level, now):
        if request.method in ('GET', 'HEAD'):
            return {'talktracks': talktrack.listing(board['id'], user.id),
                    'transcriptionAvailable': talktrack.transcription_available()}, 200
        return {'talktrack': talktrack.to_dict(talktrack.register(board['id'], user.id, now, _data(request)))}, 200
    return _guarded(handle)(request, identifier, minimum=_minimum(request))


@node_route(['GET', 'PATCH', 'DELETE'])
def board_talktrack(request, identifier, talktrack_id):
    def handle(request, user, board, level, now):
        if request.method in ('GET', 'HEAD'):
            row = talktrack._row(board['id'], talktrack_id)
            return {'talktrack': talktrack.to_dict(row)}, 200
        if request.method == 'DELETE':
            talktrack.delete(board['id'], talktrack_id, user.id, level)
            return {'deleted': True}, 200
        row = talktrack.update(board['id'], talktrack_id, user.id, level, now, _data(request))
        return {'talktrack': talktrack.to_dict(row)}, 200
    return _guarded(handle)(request, identifier, minimum=_minimum(request))


@node_route(['POST'])
def board_talktrack_view(request, identifier, talktrack_id):
    def handle(request, user, board, level, now):
        return talktrack.record_view(board['id'], talktrack_id, user.id, now, _data(request)), 200
    return _guarded(handle)(request, identifier, minimum=access.READ)


@node_route(['GET'])
def board_talktrack_viewers(request, identifier, talktrack_id):
    def handle(request, user, board, level, now):
        return talktrack.viewers(board['id'], talktrack_id), 200
    return _guarded(handle)(request, identifier, minimum=access.WRITE)


@node_route(['GET', 'POST'])
def board_talktrack_moments(request, identifier, talktrack_id):
    def handle(request, user, board, level, now):
        if request.method in ('GET', 'HEAD'):
            return {'moments': talktrack.moments(board['id'], talktrack_id)}, 200
        return {'moment': talktrack.add_moment(board['id'], talktrack_id, user.id, now, _data(request))}, 200
    return _guarded(handle)(request, identifier, minimum=_minimum(request, write=access.COMMENT))


@node_route(['DELETE'])
def board_talktrack_moment(request, identifier, talktrack_id, moment_id):
    def handle(request, user, board, level, now):
        talktrack.delete_moment(board['id'], talktrack_id, moment_id, user.id, level)
        return {'deleted': True}, 200
    return _guarded(handle)(request, identifier, minimum=access.COMMENT)


@node_route(['POST'])
def board_talktrack_transcript(request, identifier, talktrack_id):
    """Transcribe on request. Never started by anything but this call."""
    def handle(request, user, board, level, now):
        return {'talktrack': talktrack.to_dict(talktrack.make_transcript(board['id'], talktrack_id, user.id, now))}, 200
    return _guarded(handle)(request, identifier, minimum=access.WRITE)


@node_route(['GET'])
def my_talktracks(request):
    """The signed-in user's own recordings, for "Your recordings" on the dashboard. Only boards they can
    still open are listed."""
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        items = []
        for item in talktrack.mine(user.id):
            board = access.board_row(item['boardId'])
            if board is not None and access.role_for(user, board) >= access.READ:
                items.append(item)
        return reply(request, {'talktracks': items}, 200)
    except Exception:
        return failure()
