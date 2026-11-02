"""Caption routes for board video nodes. Playing and toggling need view access (the VTT is served as same-origin
text, so credentialed playback needs no crossOrigin on the video); generating needs edit access, the same as
saving the board."""
from django.http import HttpResponse
from . import access, captions
from .facilitation import FacilitationError
from .facilitation_views import _data, _guarded
from .views import UUID_PATTERN, failure, node_route, reply, with_renewal
from apps.authentication.session import lookup


@node_route(['GET', 'POST'])
def board_captions(request, identifier):
    """GET quotes a run (no provider call); POST generates, when an editor asks, and answers 202 while it runs."""
    def handle(request, user, board, level, now):
        if request.method in ('GET', 'HEAD'):
            return {'captions': captions.quote(board['id'], request.GET.get('src', ''), now)}, 200
        row = captions.generate(board['id'], _data(request).get('src'), user.id, now)
        done = bool(row.vtt)
        return {'captions': {'exists': done, 'pending': not done, 'createdAt': row.created_at}}, 200 if done else 202
    return _guarded(handle)(request, identifier, minimum=access.READ if request.method in ('GET', 'HEAD') else access.WRITE)


@node_route(['GET'])
def board_captions_vtt(request, identifier):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        board = access.board_row(identifier) if UUID_PATTERN.fullmatch(identifier) else None
        if board is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        access.require(user, board, access.READ)
        vtt = captions.vtt_for(board['id'], request.GET.get('src', ''))
        response = HttpResponse(vtt, content_type='text/vtt; charset=utf-8')
        response['Cache-Control'] = 'private, no-cache'
        response['X-Content-Type-Options'] = 'nosniff'
        return with_renewal(request, response)
    except FacilitationError as error:
        return reply(request, {'error': error.error}, error.status)
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        return failure()
