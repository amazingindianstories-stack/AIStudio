"""The in-app notification feed (the bell) written by comments and mentions; Web Push lives in `push`.

Rows are written inside the comment's transaction. A person gets at most one row per comment: a mention beats a
reply, a reply beats a new-comment notice. Nobody is notified of their own comment.
"""
from django.db import models
from apps.authentication.models import User
from apps.projects.models import Project, ProjectMember
from .collab_models import BoardComment, CommentFollow, Notification
from .models import BoardMember, CanvasBoard
from .services import now_ms

PAGE = 30
MAX_GROUP = 500
RETENTION_MS = 30 * 24 * 3600 * 1000


def _active(ids):
    return set(User.objects.filter(pk__in=ids, is_active=True).values_list('pk', flat=True))


def _group_members(board, group, author_id):
    """Who @board, @team and @space reach: board participants, every teammate, the board's project."""
    if group == 'team':
        return set(User.objects.filter(is_active=True).values_list('pk', flat=True)[:MAX_GROUP])
    if group == 'space':
        people = set(ProjectMember.objects.filter(project_id=board['project_id']).values_list('user_id', flat=True))
        creator = Project.objects.filter(pk=board['project_id']).values_list('created_by', flat=True).first()
        return _active(people | ({creator} if creator else set()))
    people = set(BoardMember.objects.filter(board_id=board['id']).values_list('user_id', flat=True))
    people |= set(BoardComment.objects.filter(board_id=board['id']).values_list('author_id', flat=True)[:MAX_GROUP])
    if board['created_by']:
        people.add(board['created_by'])
    return _active(people)


def mentioned(board, mentions, author_id):
    """(people mentioned by name, everyone the mentions reach including groups)."""
    named = _active(mentions.get('users', []))
    reached = set(named)
    for group in mentions.get('groups', []):
        reached |= _group_members(board, group, author_id)
    named.discard(author_id)
    reached.discard(author_id)
    return named, reached


def _write(board, comment, thread, kind, actor, snippet, recipients, now):
    Notification.objects.bulk_create([Notification(user_id=user_id, board_id=board['id'], kind=kind, comment_id=comment.pk,
                                                   thread_id=thread.pk, actor_id=actor.id, snippet=snippet, created_at=now)
                                      for user_id in recipients])


def comment_posted(actor, board, comment, thread, body, mentions):
    from .comments import plain
    now = now_ms()
    snippet = plain(body)
    named, reached = mentioned(board, mentions, actor.id)
    for user_id in named:
        # Being mentioned by name follows the thread, so its replies reach you; a group mention notifies once.
        CommentFollow.objects.get_or_create(board_id=board['id'], user_id=user_id, thread=thread)
    _write(board, comment, thread, 'mention', actor, snippet, reached, now)
    if comment.parent_id:
        followers = set(CommentFollow.objects.filter(board_id=board['id'], thread=thread).values_list('user_id', flat=True))
        followers |= set(CommentFollow.objects.filter(board_id=board['id'], thread__isnull=True).values_list('user_id', flat=True))
        kind = 'reply'
    else:
        followers = set(CommentFollow.objects.filter(board_id=board['id'], thread__isnull=True).values_list('user_id', flat=True))
        kind = 'comment'
    followers -= reached
    followers.discard(actor.id)
    _write(board, comment, thread, kind, actor, snippet, _active(followers), now)


def comment_edited(actor, board, row, mentions, body):
    """An edit notifies only people it newly reaches, and people it newly names follow the thread."""
    from .comments import plain
    Notification.objects.filter(comment_id=row.pk).update(snippet=plain(body))
    already = set(Notification.objects.filter(comment_id=row.pk, kind='mention').values_list('user_id', flat=True))
    named, reached = mentioned(board, mentions, actor.id)
    before = set((row.mentions or {}).get('users', []))
    thread = BoardComment.objects.get(pk=row.parent_id) if row.parent_id else row
    for user_id in named:
        if str(user_id) not in before:
            CommentFollow.objects.get_or_create(board_id=board['id'], user_id=user_id, thread=thread)
    _write(board, row, thread, 'mention', actor, plain(body), reached - already, now_ms())


def comments_deleted(comment_ids):
    """Remove the notifications that quote deleted comments."""
    Notification.objects.filter(comment_id__in=comment_ids).delete()


def unread_count(user):
    return Notification.objects.filter(user_id=user.id, read_at__isnull=True).count()


def feed(user, board_id=None, before=None, unread_only=False):
    """The caller's notifications newest first, one page at a time, for every board or one; `before` is the previous `next`."""
    rows = Notification.objects.filter(user_id=user.id)
    if board_id:
        rows = rows.filter(board_id=board_id)
    if unread_only:
        rows = rows.filter(read_at__isnull=True)
    if before is not None:
        rows = rows.filter(created_at__lt=before)
    page = list(rows.order_by('-created_at', '-id').values('id', 'board_id', 'kind', 'comment_id', 'thread_id', 'actor_id', 'snippet', 'created_at', 'read_at')[:PAGE + 1])
    more = len(page) > PAGE
    page = page[:PAGE]
    boards = {pk: (name, project) for pk, name, project in CanvasBoard.objects.filter(pk__in={row['board_id'] for row in page}).values_list('id', 'name', 'project_id')}
    items = [{'id': str(row['id']), 'boardId': str(row['board_id']), 'boardName': boards.get(row['board_id'], (None, None))[0],
              'projectId': str(boards[row['board_id']][1]) if row['board_id'] in boards else None, 'kind': row['kind'],
              'commentId': str(row['comment_id']) if row['comment_id'] else None, 'threadId': str(row['thread_id']) if row['thread_id'] else None,
              'actorId': str(row['actor_id']) if row['actor_id'] else None, 'snippet': row['snippet'], 'at': row['created_at'],
              'read': row['read_at'] is not None} for row in page]
    return {'notifications': items, 'next': page[-1]['created_at'] if more else None, 'unread': unread_count(user)}


def boards_with_activity(user):
    """The boards the caller has notifications on, with unread counts: the bell's tab per board."""
    rows = Notification.objects.filter(user_id=user.id).values('board_id').annotate(
        total=models.Count('id'), unread=models.Count('id', filter=models.Q(read_at__isnull=True)), latest=models.Max('created_at')).order_by('-latest')[:30]
    names = {pk: (name, project) for pk, name, project in CanvasBoard.objects.filter(pk__in=[row['board_id'] for row in rows]).values_list('id', 'name', 'project_id')}
    return [{'boardId': str(row['board_id']), 'name': names[row['board_id']][0], 'projectId': str(names[row['board_id']][1]), 'unread': row['unread']}
            for row in rows if row['board_id'] in names]


def mark_read(user, ids=None, board_id=None):
    rows = Notification.objects.filter(user_id=user.id, read_at__isnull=True)
    if ids is not None:
        rows = rows.filter(pk__in=ids)
    elif board_id:
        rows = rows.filter(board_id=board_id)
    rows.update(read_at=now_ms())
    return {'unread': unread_count(user)}


def prune(now=None):
    now = now_ms() if now is None else now
    return Notification.objects.filter(created_at__lt=now - RETENTION_MS).delete()[0]
