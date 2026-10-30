"""Generic in-app inbox, currently emitting only table notification kinds."""
import datetime
from apps.authentication.models import User
from . import access, services
from .models import BoardNotification, BoardNotificationPreference, WorkRecord, CanvasBoard

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


def changed(actor, board, table, before, after):
    assignee = after['cells'].get('assignee')
    payload = {'tableId': str(table.id), 'tableName': table.name, 'title': after['cells'].get('title', 'Untitled record')}
    event = f"{after['id']}:{after['version']}"
    assigned = bool(assignee and (not before or before['cells'].get('assignee') != assignee))
    if assigned:
        deliver(assignee, actor.id, board, 'table_assignment', after['id'], payload, event)
    # Changes go to the record assignee and table owner, respecting personal preferences.
    for user_id in {str(table.owner_id), assignee} - {None, '', str(actor.id)}:
        if assigned and user_id == assignee: continue
        deliver(user_id, actor.id, board, 'table_change', after['id'], payload, event)


def reminders(*, today=None):
    today = (today or datetime.datetime.now(datetime.timezone.utc).date()).isoformat()
    delivered = 0
    # Record ids and the due date form stable idempotency keys across scheduler retries.
    for record in WorkRecord.objects.filter(cells__contains={'end': today}).select_related('table').iterator(chunk_size=200):
        assignee = record.cells.get('assignee')
        if not assignee: continue
        board = access.board_row(record.table.board_id)
        if board:
            delivered += deliver(assignee, None, board, 'table_due', record.id,
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
