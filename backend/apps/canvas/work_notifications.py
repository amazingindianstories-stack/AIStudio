"""Generic in-app inbox, currently emitting only table notification kinds."""
import datetime
from apps.authentication.models import User
from . import access, services
from .models import BoardNotification, BoardNotificationPreference, WorkRecord, WorkTable, CanvasBoard

KINDS = ('table_assignment', 'table_due', 'table_change')
DEFAULTS = {kind: True for kind in KINDS}


def preferences(user):
    row = BoardNotificationPreference.objects.filter(user_id=user.id).first()
    stored = row.preferences if row else {}
    return {kind: stored.get(kind, True) for kind in KINDS}


def deliver(user_id, actor_id, board, kind, target_id, payload, event):
    recipient = User.objects.filter(id=user_id, is_active=True).first()
    if not recipient or access.role_for(recipient, board) < access.READ or not preferences(recipient)[kind]: return False
    _, created = BoardNotification.objects.get_or_create(event_key=f'{kind}:{event}:{user_id}', defaults={
        'user_id': recipient.id, 'actor_id': actor_id, 'board_id': board['id'], 'kind': kind,
        'target_id': str(target_id), 'payload': payload, 'created_at': services.now_ms()})
    return created


def assignees(schema, cells):
    return {cells[f['id']] for f in schema if f['type'] == 'people' and isinstance(cells.get(f['id']), str) and cells[f['id']]}


def end_field(table):
    dates = {f['id'] for f in table.fields if f['type'] == 'date'}
    return next((v['endField'] for v in table.views if v.get('kind') == 'timeline' and v.get('endField') in dates), 'end')


def changed(actor, board, table, before, after):
    people = assignees(table.fields, after['cells'])
    payload = {'tableId': str(table.id), 'tableName': table.name, 'title': after['cells'].get('title', 'Untitled record')}
    event = f"{after['id']}:{after['version']}"
    assigned = people - (assignees(table.fields, before['cells']) if before else set())
    for user_id in assigned:
        deliver(user_id, actor.id, board, 'table_assignment', after['id'], payload, event)
    # Changes go to the record's people and table owner, respecting personal preferences.
    for user_id in ({str(table.owner_id)} | people) - assigned - {str(actor.id)}:
        deliver(user_id, actor.id, board, 'table_change', after['id'], payload, event)


def reminders(*, today=None):
    today = (today or datetime.datetime.now(datetime.timezone.utc).date()).isoformat()
    delivered = 0
    tables = {}
    for table in WorkTable.objects.only('id', 'fields', 'views').iterator(chunk_size=500):
        tables.setdefault(end_field(table), []).append(table.id)
    boards = {}
    # Record ids and the due date form stable idempotency keys across scheduler retries.
    for field, ids in tables.items():
        for record in WorkRecord.objects.filter(table_id__in=ids, cells__contains={field: today}).select_related('table').iterator(chunk_size=200):
            board_id = record.table.board_id
            if board_id not in boards: boards[board_id] = access.board_row(board_id)
            if not boards[board_id]: continue
            for user_id in assignees(record.table.fields, record.cells):
                delivered += deliver(user_id, None, boards[board_id], 'table_due', record.id,
                                     {'tableId': str(record.table_id), 'tableName': record.table.name,
                                      'title': record.cells.get('title', 'Untitled record'), 'end': today}, f'{record.id}:{today}')
    return {'delivered': delivered}


def inbox(user):
    rows = list(BoardNotification.objects.filter(user=user).order_by('-created_at', '-id')[:200])
    boards = list(CanvasBoard.objects.filter(id__in={row.board_id for row in rows}).values('id', 'project_id', 'created_by', 'team_role'))
    roles = access.roles_for(user, boards)
    return [{'id': str(row.id), 'kind': row.kind, 'actorId': str(row.actor_id) if row.actor_id else None,
             'boardId': str(row.board_id), 'targetId': row.target_id, 'payload': row.payload, 'createdAt': row.created_at,
             'readAt': row.read_at} for row in rows if roles.get(str(row.board_id), access.NONE) >= access.READ]
