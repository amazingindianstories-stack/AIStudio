"""Facilitation routes (area D): the board's poll snapshot, timer, voting sessions and private mode."""
from . import access, facilitation, services
from .models import CanvasBoard
from .views import UUID_PATTERN, body, failure, node_route, property_of, reply
from apps.authentication.session import lookup


def _data(request):
    data = body(request)
    return data if isinstance(data, dict) else {}


def _guarded(handler):
    """Resolve the user and board, check the effective level the route needs, and map facilitation and access
    errors to JSON. `handler(request, user, board, level, now)` returns a reply payload."""
    def run(request, identifier, *args, minimum, **kwargs):
        user = lookup(request)
        if user is None:
            return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
        try:
            existing = access.board_row(identifier) if UUID_PATTERN.fullmatch(identifier) else None
            if existing is None:
                return reply(request, {'error': 'Board not found.'}, 404)
            level = access.require(user, existing, minimum)
            payload, status = handler(request, user, existing, level, services.now_ms(), *args, **kwargs)
            return reply(request, payload, status)
        except facilitation.FacilitationError as error:
            return reply(request, {'error': error.error}, error.status)
        except access.AccessError as error:
            return reply(request, {'error': str(error)}, error.status)
        except Exception:
            return failure()
    return run


def _graph(board_id):
    return CanvasBoard.objects.filter(pk=board_id).values_list('data', flat=True).first() or {}


@node_route(['GET'])
def board_facilitation(request, identifier):
    """Polled while a board is open: one read of the timer, voting and private mode state."""
    def handle(request, user, board, level, now):
        return facilitation.snapshot(board['id'], user.id, level, now), 200
    return _guarded(handle)(request, identifier, minimum=access.READ)


@node_route(['POST'])
def board_timer(request, identifier):
    def handle(request, user, board, level, now):
        return {'timer': facilitation.timer_action(board['id'], user.id, now, _data(request)), 'serverNow': now}, 200
    return _guarded(handle)(request, identifier, minimum=access.WRITE)


@node_route(['GET', 'POST'])
def board_voting(request, identifier):
    """GET lists the voting history; POST creates (and starts, or saves) a session."""
    def handle(request, user, board, level, now):
        if request.method in ('GET', 'HEAD'):
            return {'sessions': facilitation.list_sessions(board['id'], user.id, now, _graph(board['id']))}, 200
        if level < access.WRITE:
            raise access.AccessError('FORBIDDEN', 403)
        session = facilitation.create_session(board['id'], user.id, now, _data(request))
        return {'session': facilitation._session_dict(session)}, 200
    return _guarded(handle)(request, identifier, minimum=access.READ)


@node_route(['POST'])
def board_voting_session(request, identifier, session_id):
    def handle(request, user, board, level, now):
        if not UUID_PATTERN.fullmatch(session_id):
            raise facilitation.FacilitationError('Voting session not found.', 404)
        session = facilitation.session_action(board['id'], session_id, user.id, now, _data(request))
        return {'session': facilitation._session_dict(session) if session else None, 'deleted': session is None}, 200
    return _guarded(handle)(request, identifier, minimum=access.WRITE)


@node_route(['POST'])
def board_voting_vote(request, identifier, session_id):
    def handle(request, user, board, level, now):
        if not UUID_PATTERN.fullmatch(session_id):
            raise facilitation.FacilitationError('Voting session not found.', 404)
        return {'myVotes': facilitation.cast_vote(board['id'], session_id, user.id, now, _data(request))}, 200
    return _guarded(handle)(request, identifier, minimum=access.COMMENT)


@node_route(['POST'])
def board_voting_done(request, identifier, session_id):
    def handle(request, user, board, level, now):
        if not UUID_PATTERN.fullmatch(session_id):
            raise facilitation.FacilitationError('Voting session not found.', 404)
        facilitation.mark_done(board['id'], session_id, user.id, now, property_of(_data(request), 'done') is not False)
        return {'ok': True}, 200
    return _guarded(handle)(request, identifier, minimum=access.COMMENT)


@node_route(['POST'])
def board_private_mode(request, identifier):
    def handle(request, user, board, level, now):
        return {'privateMode': facilitation.private_action(board['id'], user.id, level, now, _data(request))}, 200
    return _guarded(handle)(request, identifier, minimum=access.WRITE)
