"""The board REST API: `/api/v1/boards`, for scripts and integrations that hold a Veevee agent token.

It is the item-level view of the board the editor saves whole (apps.canvas.board_items). Authentication is the
existing agent access (personal access tokens and OAuth access tokens from Settings, Agent access): the same
tokens, per-user opt-in and revocation as the MCP server, with the scopes `veevee.boards.read` and
`veevee.boards.write`. A token acts as its user, so board roles decide everything: a viewer or commenter token can
read but not change a board, whatever its scopes. Every call spends credits from the grant's budget
(`policy.BOARD_COSTS`) and every response says what is left (X-RateLimit-Limit, -Remaining, -Reset).
A polled change feed (`/changes?since=<version>`) stands in for webhooks.
"""
import re

from django.http import HttpResponse

from apps.mcp_auth import controls, policy
from apps.mcp_auth.principal import AgentAccessDisabled, AuthenticationError, authenticate_bearer
from . import access, board_items, services
from .models import CanvasBoard
from .serialization import js_json
from .views import body, failure, node_route

BOARD_LIMIT = 500
SINCE = re.compile(r'[0-9]{1,16}')
ITEM_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')


class Refusal(Exception):
    def __init__(self, status, code, message, headers=None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


def credit_headers(result):
    return {'X-RateLimit-Limit': str(result.limit), 'X-RateLimit-Remaining': str(max(0, result.limit - result.count)),
            'X-RateLimit-Reset': str(result.retry_after_seconds)}


def respond(payload, status=200, headers=None):
    response = HttpResponse(js_json(payload), status=status, content_type='application/json')
    response['Cache-Control'] = 'no-store'
    for key, value in (headers or {}).items():
        response[key] = value
    return response


def fail(refusal):
    return respond({'error': refusal.code, 'message': refusal.message}, refusal.status, refusal.headers)


def authorize(request, scope, cost):
    """The principal for a call that needs `scope`, with its credits spent: `(principal, headers)`."""
    try:
        principal = authenticate_bearer(request.headers.get('Authorization'))
    except AgentAccessDisabled as error:
        raise Refusal(403, error.code, str(error)) from None
    except AuthenticationError as error:
        raise Refusal(error.status, error.error or 'invalid_request', error.body()['error_description'],
                      {'WWW-Authenticate': error.www_authenticate()}) from None
    if not principal.has_scope(scope):
        raise Refusal(403, 'insufficient_scope', f'This call needs the {scope} scope.',
                      {'WWW-Authenticate': AuthenticationError('insufficient_scope', scope=scope).www_authenticate()})
    if scope == 'veevee.boards.write':
        from apps.mcp.runtime import admin_switch_on
        if not admin_switch_on():
            raise Refusal(403, 'MCP_DISABLED', 'Agent writes are switched off by a Veevee admin.')
    try:
        return principal, credit_headers(controls.check_credits(principal, cost))
    except controls.RateLimited as error:
        limit = policy.BOARD_CREDITS[0]
        raise Refusal(429, 'RATE_LIMITED', error.message, {
            'Retry-After': str(error.retry_after_seconds), 'X-RateLimit-Limit': str(limit), 'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': str(error.retry_after_seconds)}) from None


def board_for(principal, identifier, needed):
    """The principal's level on the board (board_items.require_board)."""
    return board_items.require_board(principal.user, identifier, needed)


def guarded(handler):
    """Turn refusals and item errors into the API's JSON errors; anything else is a bare 500."""
    def wrapped(request, *args, **kwargs):
        try:
            return handler(request, *args, **kwargs)
        except Refusal as refusal:
            return fail(refusal)
        except board_items.ItemError as error:
            return respond({'error': error.code, 'message': error.message}, error.status)
        except Exception:
            return failure()
    wrapped.__name__ = handler.__name__
    return wrapped


def page_args(request):
    limit, cursor = request.GET.get('limit', ''), request.GET.get('cursor', '')
    if (limit and not re.fullmatch(r'[0-9]{1,4}', limit)) or (cursor and not re.fullmatch(r'[0-9]{1,9}', cursor)):
        raise Refusal(400, 'INVALID_PAGE', 'limit and cursor must be whole numbers.')
    return {'limit': int(limit) if limit else board_items.DEFAULT_PAGE, 'cursor': int(cursor) if cursor else 0}


@node_route(['GET'])
@guarded
def boards(request):
    principal, headers = authorize(request, 'veevee.boards.read', 'list')
    rows = list(CanvasBoard.objects.order_by('-updated_at').values(*services.META_FIELDS)[:BOARD_LIMIT])
    levels = access.roles_for(principal.user, rows)
    found = [{**services.metadata(row), 'role': access.LEVEL_NAMES[levels[str(row['id'])]]}
             for row in rows if levels[str(row['id'])] >= access.READ]
    return respond({'boards': found}, headers=headers)


@node_route(['GET'])
@guarded
def board(request, identifier):
    principal, headers = authorize(request, 'veevee.boards.read', 'read')
    level = board_for(principal, identifier, access.READ)
    return respond({**board_items.summary(identifier, level, principal.user.id), 'role': access.LEVEL_NAMES[level]}, headers=headers)


def collection(kind):
    @node_route(['GET', 'POST'])
    @guarded
    def handler(request, identifier):
        if request.method in ('GET', 'HEAD'):
            principal, headers = authorize(request, 'veevee.boards.read', 'list')
            level = board_for(principal, identifier, access.READ)
            kind_filter = request.GET.get('type')
            return respond(board_items.page(identifier, kind, type=kind_filter or None, level=level,
                                            viewer=principal.user.id, **page_args(request)), headers=headers)
        payload = body(request)
        many = payload.get('items') if isinstance(payload, dict) else None
        if many is not None and (not isinstance(many, list) or len(many) > policy.BOARD_BULK_MAX):
            raise Refusal(400, 'INVALID_ITEM', f'items must be a list of at most {policy.BOARD_BULK_MAX} objects.')
        single = payload.get('item') if isinstance(payload, dict) else None
        raws = many if many is not None else ([single] if single is not None else [])
        principal, headers = authorize(request, 'veevee.boards.write', 'bulk' if len(raws) > 1 else 'write')
        level = board_for(principal, identifier, access.WRITE)
        created, version = board_items.create(identifier, principal.user.id, level, kind, raws)
        return respond({'items': created, 'version': version}, 201, headers)
    handler.__name__ = f'{kind}_collection'
    return handler


def member(kind):
    @node_route(['GET', 'PATCH', 'DELETE'])
    @guarded
    def handler(request, identifier, item_id):
        if not ITEM_ID.fullmatch(item_id):
            raise board_items.not_found(kind)
        if request.method in ('GET', 'HEAD'):
            principal, headers = authorize(request, 'veevee.boards.read', 'read')
            level = board_for(principal, identifier, access.READ)
            return respond(board_items.get(identifier, kind, item_id, level, principal.user.id), headers=headers)
        principal, headers = authorize(request, 'veevee.boards.write', 'write')
        level = board_for(principal, identifier, access.WRITE)
        if request.method == 'DELETE':
            return respond({'ok': True, 'version': board_items.delete(identifier, principal.user.id, level, kind, item_id)},
                           headers=headers)
        payload = body(request)
        item, version = board_items.update(identifier, principal.user.id, level, kind, item_id,
                                           payload.get('fields') if isinstance(payload, dict) else None)
        return respond({'item': item, 'version': version}, headers=headers)
    handler.__name__ = f'{kind}_member'
    return handler


@node_route(['GET'])
@guarded
def board_change_feed(request, identifier):
    principal, headers = authorize(request, 'veevee.boards.read', 'list')
    level = board_for(principal, identifier, access.READ)
    since = request.GET.get('since', '')
    if not SINCE.fullmatch(since):
        raise Refusal(400, 'INVALID_VERSION', 'since must be a board version number.')
    return respond(board_items.changes(identifier, int(since), level, principal.user.id), headers=headers)


items_collection, items_member = collection('items'), member('items')
connectors_collection, connectors_member = collection('connectors'), member('connectors')
