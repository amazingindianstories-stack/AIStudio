"""Routes for board comments, presence and the notification feed. Reading needs view access; commenting needs
comment access (viewers cannot comment); only a comment's author edits it, and its author or a board sharer deletes it."""
import re
from . import access, comments, notifications, push
from .views import UUID_PATTERN, body, failure, node_route, property_of, reply
from apps.authentication.session import lookup

CURSOR = re.compile(r'[0-9]{1,16}')


def _handle(request, identifier, needed, action):
    """Run `action(user, board_row)` for a signed-in caller with `needed` access to the board."""
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        board = access.board_row(identifier) if UUID_PATTERN.fullmatch(identifier) else None
        if board is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        access.require(user, board, needed)
        return action(user, board)
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except comments.CommentError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        return failure()


def _since(request):
    raw = request.GET.get('since')
    return int(raw) if raw and CURSOR.fullmatch(raw) else None


def _payload(request):
    data = body(request)
    return data if isinstance(data, dict) else {}


@node_route(['GET', 'POST'])
def board_comments(request, identifier):
    if request.method == 'POST':
        return _handle(request, identifier, access.COMMENT,
                       lambda user, board: reply(request, {'comment': comments.create(user, board, _payload(request))}, 201))
    return _handle(request, identifier, access.READ, lambda user, board: reply(request, {
        'comments': comments.list_comments(user, board, _since(request)), 'follows': comments.follows(user, board)}))


@node_route(['PATCH', 'DELETE'])
def board_comment(request, identifier, comment_id):
    if request.method == 'DELETE':
        return _handle(request, identifier, access.COMMENT, lambda user, board: reply(request, comments.delete(user, board, comment_id)))
    return _handle(request, identifier, access.COMMENT, lambda user, board: reply(request, {'comment': comments.update(user, board, comment_id, _payload(request))}))


@node_route(['POST'])
def board_comment_resolve(request, identifier, comment_id):
    return _handle(request, identifier, access.COMMENT, lambda user, board: reply(request, {
        'comment': comments.resolve(user, board, comment_id, _payload(request).get('resolved') is not False)}))


@node_route(['POST'])
def board_comment_react(request, identifier, comment_id):
    return _handle(request, identifier, access.COMMENT, lambda user, board: reply(request, {
        'comment': comments.react(user, board, comment_id, property_of(_payload(request), 'emoji'))}))


@node_route(['POST'])
def board_comments_read(request, identifier):
    def run(user, board):
        data = _payload(request)
        return reply(request, comments.mark_read(user, board, None if data.get('all') is True else data.get('ids', []), data.get('unread') is True))
    return _handle(request, identifier, access.READ, run)


@node_route(['POST'])
def board_comments_follow(request, identifier):
    def run(user, board):
        data = _payload(request)
        return reply(request, comments.follow(user, board, data.get('threadId'), data.get('follow') is not False))
    return _handle(request, identifier, access.READ, run)


@node_route(['GET'])
def board_mention_suggestions(request, identifier):
    return _handle(request, identifier, access.COMMENT, lambda user, board: reply(request, {'userIds': comments.suggestions(user, board)}))


@node_route(['POST'])
def board_pulse(request, identifier):
    """The board's second poll, beside /version: presence beat, people here, new comments, unread count."""
    return _handle(request, identifier, access.READ, lambda user, board: reply(request, comments.pulse(user, board, _since(request))))


@node_route(['GET'])
def notification_feed(request):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        board_id = request.GET.get('boardId')
        if board_id is not None and not UUID_PATTERN.fullmatch(board_id):
            return reply(request, {'error': 'Invalid board.'}, 400)
        before = request.GET.get('before')
        if before is not None and not CURSOR.fullmatch(before):
            return reply(request, {'error': 'Invalid cursor.'}, 400)
        result = notifications.feed(user, board_id, int(before) if before else None, request.GET.get('unread') == '1')
        if request.GET.get('boards') == '1':
            result['boards'] = notifications.boards_with_activity(user)
        return reply(request, result)
    except Exception:
        return failure()


@node_route(['POST'])
def notification_read(request):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        data = _payload(request)
        ids = data.get('ids')
        if ids is not None and (not isinstance(ids, list) or len(ids) > 200 or not all(isinstance(i, str) and UUID_PATTERN.fullmatch(i) for i in ids)):
            return reply(request, {'error': 'Invalid ids.'}, 400)
        board_id = data.get('boardId')
        if board_id is not None and not (isinstance(board_id, str) and UUID_PATTERN.fullmatch(board_id)):
            return reply(request, {'error': 'Invalid board.'}, 400)
        return reply(request, notifications.mark_read(user, ids, board_id))
    except Exception:
        return failure()


@node_route(['GET', 'POST', 'DELETE'])
def push_subscription(request):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        if request.method == 'POST':
            if push.config() is None:
                return reply(request, {'error': 'Push notifications are not enabled on this server.'}, 409)
            try:
                push.subscribe(user, property_of(_payload(request), 'endpoint'))
            except ValueError as error:
                return reply(request, {'error': str(error)}, 400)
        elif request.method == 'DELETE':
            push.unsubscribe(user, property_of(_payload(request), 'endpoint'))
        return reply(request, push.status(user))
    except Exception:
        return failure()
