"""HTTP routes for Sidekicks, Flows, Catch up, AI search and AI credits.

Two dispatchers keep the route table short: ``board_assistant`` serves everything scoped to one board
(``/api/canvas-boards/<id>/assistant/<action>``) and ``canvas_ai`` serves what belongs to the person
(``/api/canvas-ai/<action>``: Sidekicks, credits, Flow templates, usage). Editing a Sidekick chat or a Flow needs
edit access, since its results land on the board; Catch up and AI search only read, so viewers and commenters may use them.
"""
import re

from apps.authentication.session import lookup
from . import access, flows, sidekicks
from .models import CanvasBoard
from .views import ai_failure, body, failure, node_route, reply

ID = r'([0-9a-fA-F-]{36})'


def board_at(actor, identifier, level):
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', identifier):
        return None
    existing = access.board_row(identifier)
    if existing is None:
        return None
    access.require(actor, existing, level)
    return CanvasBoard.objects.filter(pk=identifier).first()


def key_of(request):
    return request.headers.get('Idempotency-Key')


def query(request, name):
    values = request.query_params.getlist(name)
    return values[0] if values else None


# (method, pattern, access level, handler(request, actor, board, *groups) -> (payload, status))
BOARD_ROUTES = [
    ('GET', r'sidekick-chats', access.EDIT, lambda r, a, b: ({'chats': sidekicks.list_chats(a, b)}, 200)),
    ('POST', r'sidekick-chats', access.EDIT, lambda r, a, b: ({'chat': sidekicks.create_chat(a, b, body(r))}, 201)),
    ('GET', rf'sidekick-chats/{ID}', access.EDIT,
     lambda r, a, b, c: ({'chat': sidekicks.chat_json(sidekicks.own_chat(a, b, c)), 'turns': sidekicks.chat_turns(a, b, sidekicks.own_chat(a, b, c))}, 200)),
    ('PATCH', rf'sidekick-chats/{ID}', access.EDIT, lambda r, a, b, c: ({'chat': sidekicks.rename_chat(a, b, c, body(r))}, 200)),
    ('DELETE', rf'sidekick-chats/{ID}', access.EDIT, lambda r, a, b, c: (sidekicks.delete_chat(a, b, c), 200)),
    ('POST', rf'sidekick-chats/{ID}/quote', access.EDIT, lambda r, a, b, c: ({'quote': sidekicks.quote_turn(a, b, c, body(r))}, 200)),
    ('POST', rf'sidekick-chats/{ID}/turns', access.EDIT, lambda r, a, b, c: ({'job': sidekicks.submit_turn(a, b, c, body(r), key_of(r))}, 201)),
    ('POST', r'flows/quote', access.EDIT, lambda r, a, b: ({'quote': flows.quote_flow(a, body(r))}, 200)),
    ('POST', r'flows/steps/quote', access.EDIT, lambda r, a, b: ({'quote': flows.quote_step(a, body(r))}, 200)),
    ('POST', r'flows/steps', access.EDIT, lambda r, a, b: ({'job': flows.submit_step(a, b, body(r), key_of(r))}, 201)),
    ('GET', r'flow-versions', access.EDIT, lambda r, a, b: ({'versions': flows.list_versions(b, query(r, 'nodeId'))}, 200)),
    ('POST', r'flow-versions', access.EDIT, lambda r, a, b: (flows.record_version(a, b, body(r)), 201)),
    ('POST', r'visit', access.READ, lambda r, a, b: (flows.visit(a, b), 200)),
    ('GET', r'catch-up', access.READ, lambda r, a, b: ({'catchUp': flows.catchup_info(a, b, query(r, 'period'))}, 200)),
    ('POST', r'catch-up/quote', access.READ, lambda r, a, b: ({'quote': flows.quote_catchup(a, b, body(r))}, 200)),
    ('POST', r'catch-up/jobs', access.READ, lambda r, a, b: ({'job': flows.submit_catchup(a, b, body(r), key_of(r))}, 201)),
    ('POST', r'ai-search/quote', access.READ, lambda r, a, b: ({'quote': flows.quote_search(a, body(r))}, 200)),
    ('POST', r'ai-search/jobs', access.READ, lambda r, a, b: ({'job': flows.submit_search(a, b, body(r), key_of(r))}, 201)),
    ('GET', rf'ai-search/{ID}', access.READ, lambda r, a, b, j: (flows.apply_search(a, b, j), 200)),
    ('GET', rf'work/{ID}', access.READ, lambda r, a, b, j: ({'job': sidekicks.get_job(a, b, j)}, 200)),
]

PERSONAL_ROUTES = [
    ('GET', r'sidekicks', lambda r, a: (sidekicks.catalogue(a), 200)),
    ('POST', r'sidekicks', lambda r, a: ({'sidekick': sidekicks.save_sidekick(a, None, body(r))}, 201)),
    ('PATCH', rf'sidekicks/{ID}', lambda r, a, i: ({'sidekick': sidekicks.save_sidekick(a, i, body(r))}, 200)),
    ('DELETE', rf'sidekicks/{ID}', lambda r, a, i: (sidekicks.delete_sidekick(a, i), 200)),
    ('GET', r'credits', lambda r, a: ({'credits': sidekicks.credits(a)}, 200)),
    ('POST', r'credits/request', lambda r, a: (sidekicks.request_more_credits(a, (body(r) or {}).get('message')), 200)),
    ('GET', r'flow-templates', lambda r, a: ({'templates': flows.FLOW_TEMPLATES}, 200)),
]


def admin_usage(request, actor):
    if getattr(actor, 'role', None) != 'admin':
        return {'error': 'FORBIDDEN'}, 403
    data = body(request) if request.method == 'POST' else {}
    return {'usage': flows.usage(data if isinstance(data, dict) else {})}, 200


def dispatch(request, table, action, *args):
    for entry in table:
        if entry[0] == request.method.replace('HEAD', 'GET') and (match := re.fullmatch(entry[1], action)):
            return entry, match
    return None, None


@node_route(['GET', 'POST', 'PATCH', 'DELETE'])
def board_assistant(request, identifier, action):
    actor = lookup(request)
    if actor is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        entry, match = dispatch(request, BOARD_ROUTES, action)
        if entry is None:
            return reply(request, {'error': 'Not found.'}, 404)
        board = board_at(actor, identifier, entry[2])
        if board is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        try:
            payload, status = entry[3](request, actor, board, *match.groups())
        except Exception as error:
            return ai_failure(request, error)
        return reply(request, payload, status)
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        return failure()


@node_route(['GET', 'POST', 'PATCH', 'DELETE'])
def canvas_ai(request, action):
    actor = lookup(request)
    if actor is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        if action == 'usage':
            payload, status = admin_usage(request, actor)
            return reply(request, payload, status)
        entry, match = dispatch(request, PERSONAL_ROUTES, action)
        if entry is None:
            return reply(request, {'error': 'Not found.'}, 404)
        try:
            payload, status = entry[2](request, actor, *match.groups())
        except Exception as error:
            return ai_failure(request, error)
        return reply(request, payload, status)
    except Exception:
        return failure()
