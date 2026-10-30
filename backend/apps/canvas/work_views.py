"""HTTP transport for shared work records and the generic notification inbox."""
from apps.authentication.session import lookup
from . import access
from .views import node_route, reply, body
from .models import WorkTable, WorkHistory, BoardNotification, BoardNotificationPreference
from . import work_tables as work
from . import work_notifications as notifications


def context(request, board_id):
    actor = lookup(request)
    if actor is None: raise access.AccessError('UNAUTHENTICATED', 401)
    board = access.board_row(work.identifier(board_id))
    if not board: raise access.AccessError('Board not found.', 404)
    access.require(actor, board, access.READ)
    return actor, board


def error(request, exception):
    return reply(request, {'error': str(exception)}, getattr(exception, 'status', 400))


@node_route(['GET', 'POST'])
def tables(request, identifier):
    try:
        actor, board = context(request, identifier)
        if request.method in ('GET', 'HEAD'):
            return reply(request, {'tables': [work.describe(t, actor, board) for t in WorkTable.objects.filter(board_id=board['id']).order_by('created_at')]})
        data = body(request)
        if not isinstance(data, dict): raise work.WorkError('Expected an object.')
        return reply(request, {'table': work.create_table(actor, board, data)}, 201)
    except (ValueError, access.AccessError) as exception:
        return error(request, exception)


@node_route(['GET', 'POST'])
def table_detail(request, identifier, table_id):
    try:
        actor, board = context(request, identifier)
        table = WorkTable.objects.filter(id=work.identifier(table_id), board_id=board['id']).first()
        if not table: raise access.AccessError('Table not found.', 404)
        if request.method in ('GET', 'HEAD'):
            return reply(request, {'table': work.describe(table, actor, board), **work.query(table, request.query_params)})
        data = body(request)
        if not isinstance(data, dict): raise work.WorkError('Expected an object.')
        return reply(request, work.mutate(actor, board, table.id, data))
    except (ValueError, access.AccessError) as exception:
        return error(request, exception)


@node_route(['GET'])
def table_history(request, identifier, table_id):
    try:
        actor, board = context(request, identifier)
        table = WorkTable.objects.filter(id=work.identifier(table_id), board_id=board['id']).first()
        if not table: raise access.AccessError('Table not found.', 404)
        try: offset = max(0, int(request.query_params.get('offset', 0)))
        except ValueError as exception: raise work.WorkError('Invalid offset.') from exception
        rows = WorkHistory.objects.filter(table=table).order_by('-created_at', '-id')[offset:offset+100]
        return reply(request, {'history': [{'id': str(row.id), 'actorId': str(row.actor_id), 'targetId': row.target_id,
                                           'action': row.action, 'before': row.before, 'after': row.after, 'createdAt': row.created_at} for row in rows]})
    except (ValueError, access.AccessError) as exception:
        return error(request, exception)


@node_route(['GET', 'POST'])
def notification_inbox(request):
    actor = lookup(request)
    if actor is None: return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        if request.method not in ('GET', 'HEAD'):
            data = body(request)
            if not isinstance(data, dict): raise work.WorkError('Expected an object.')
            if data.get('op') == 'preferences':
                preferences = data.get('preferences')
                if not isinstance(preferences, dict) or any(type(v) is not bool for k, v in preferences.items() if k in notifications.KINDS):
                    raise work.WorkError('Notification preferences must be boolean.')
                BoardNotificationPreference.objects.update_or_create(user=actor, defaults={'preferences': {**notifications.preferences(actor), **{k: v for k, v in preferences.items() if k in notifications.KINDS}}})
            elif data.get('op') == 'read':
                from .services import now_ms
                BoardNotification.objects.filter(id=work.identifier(data.get('id')), user=actor).update(read_at=now_ms())
            else: raise work.WorkError('Unknown notification operation.')
        return reply(request, {'notifications': notifications.inbox(actor), 'preferences': notifications.preferences(actor)})
    except (ValueError, access.AccessError) as exception:
        return error(request, exception)
