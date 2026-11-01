"""Board comments: threads anchored to a node or to board coordinates, drafts aside (those stay in the browser).

Everything here is keyed by a board row from `access.board_row`; the views check the caller's level first
(reading needs view, writing needs comment). Notifications are written in the comment's transaction by
`apps.canvas.notifications`; the poll (`pulse`) carries new and changed comments, presence and the unread count.
"""
import math
import re
from django.db import models, transaction
from apps.authentication.models import User
from apps.projects.models import Project, ProjectMember
from . import access, notifications
from .collab_models import BoardComment, BoardPresence, CommentFollow, CommentRead, CommentReaction
from .models import BoardMember
from .services import now_ms

MAX_BODY = 4000
MAX_COMMENTS_PER_BOARD = 3000
MAX_REPLIES_PER_THREAD = 500
TOMBSTONE_MS = 24 * 3600 * 1000
PRESENCE_MS = 30000
POLL_OVERLAP_MS = 2500
EMOJIS = ('👍', '👎', '❤️', '🎉', '😄', '😮', '😢', '👀', '🔥', '✅', '❓', '🙏')
COLOR = re.compile(r'#[0-9a-fA-F]{6}')
MENTION = re.compile(r'@\[([^\]\n]{1,80})\]\((user:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|board|team|space)\)')
COORD_LIMIT = 10_000_000


class CommentError(Exception):
    def __init__(self, error, status=400):
        super().__init__(error)
        self.status = status


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > COORD_LIMIT:
        raise CommentError('Invalid position.')
    return float(value)


def plain(body, limit=140):
    """The body with mention tokens shown as @Name, cut for a notification line."""
    text = MENTION.sub(lambda m: '@' + m[1], body).strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '...'


def parse_mentions(body):
    users, groups = [], []
    for match in MENTION.finditer(body):
        token = match[2]
        if token.startswith('user:'):
            if token[5:].lower() not in users:
                users.append(token[5:].lower())
        elif token not in groups:
            groups.append(token)
    return {'users': users, 'groups': groups}


def _clean_body(value):
    if not isinstance(value, str) or not value.strip():
        raise CommentError('Comment text required.')
    value = value.strip()
    if len(value) > MAX_BODY:
        raise CommentError('Comment is too long.')
    return value


def _clean_color(value):
    if value is None:
        return None
    if not isinstance(value, str) or not COLOR.fullmatch(value):
        raise CommentError('Invalid color.')
    return value.lower()


def _anchor(data):
    """(anchor_node_id, dx, dy, x, y) from a request: a node anchor needs its offset, board coordinates are optional with one."""
    node = data.get('anchorNodeId')
    if node is not None and (not isinstance(node, str) or not 0 < len(node) <= 100):
        raise CommentError('Invalid anchor.')
    dx = _number(data['anchorDx']) if node and data.get('anchorDx') is not None else (0.0 if node else None)
    dy = _number(data['anchorDy']) if node and data.get('anchorDy') is not None else (0.0 if node else None)
    x, y = (_number(data['x']), _number(data['y'])) if data.get('x') is not None and data.get('y') is not None else (None, None)
    if node is None and x is None:
        raise CommentError('Position required.')
    return node, dx, dy, x, y


def _dict(row, reactions, read):
    deleted = row['deleted_at'] is not None
    return {'id': str(row['id']), 'parentId': str(row['parent_id']) if row['parent_id'] else None,
            'authorId': str(row['author_id']), 'body': '' if deleted else row['body'], 'color': row['color'],
            'anchor': {'nodeId': row['anchor_node_id'], 'dx': row['anchor_dx'], 'dy': row['anchor_dy']} if row['anchor_node_id'] else None,
            'x': row['x'], 'y': row['y'], 'mentions': row['mentions'] or {'users': [], 'groups': []},
            'resolvedAt': row['resolved_at'], 'resolvedBy': str(row['resolved_by']) if row['resolved_by'] else None,
            'deleted': deleted, 'createdAt': row['created_at'], 'updatedAt': row['updated_at'], 'editedAt': row['edited_at'],
            'reactions': reactions, 'read': read}


FIELDS = ('id', 'parent_id', 'author_id', 'body', 'color', 'anchor_node_id', 'anchor_dx', 'anchor_dy', 'x', 'y', 'mentions',
          'resolved_at', 'resolved_by', 'deleted_at', 'created_at', 'updated_at', 'edited_at')


def _serialize(user, rows):
    ids = [row['id'] for row in rows]
    reactions = {}
    for comment_id, who, emoji in CommentReaction.objects.filter(comment_id__in=ids).order_by('created_at').values_list('comment_id', 'user_id', 'emoji'):
        reactions.setdefault(comment_id, {}).setdefault(emoji, []).append(str(who))
    seen = set(CommentRead.objects.filter(user_id=user.id, comment_id__in=ids).values_list('comment_id', flat=True))
    return [_dict(row, reactions.get(row['id'], {}), row['author_id'] == user.id or row['id'] in seen or row['deleted_at'] is not None) for row in rows]


def list_comments(user, board, since=None):
    """Comments changed since `since` (a poll; includes deleted tombstones), or all of them. Roots newest last."""
    rows = BoardComment.objects.filter(board_id=board['id'])
    if since is not None:
        rows = rows.filter(updated_at__gte=since - POLL_OVERLAP_MS)
    else:
        rows = rows.filter(deleted_at__isnull=True)
    return _serialize(user, list(rows.order_by('created_at', 'id').values(*FIELDS)[:MAX_COMMENTS_PER_BOARD]))


def follows(user, board):
    rows = list(CommentFollow.objects.filter(board_id=board['id'], user_id=user.id).values_list('thread_id', flat=True))
    return {'all': None in rows, 'threads': [str(thread) for thread in rows if thread]}


def _prune(board_id, now):
    BoardComment.objects.filter(board_id=board_id, deleted_at__lt=now - TOMBSTONE_MS, parent__isnull=True).delete()
    BoardComment.objects.filter(board_id=board_id, deleted_at__lt=now - TOMBSTONE_MS).delete()
    BoardPresence.objects.filter(board_id=board_id, seen_at__lt=now - TOMBSTONE_MS).delete()


def create(user, board, data):
    body = _clean_body(data.get('body'))
    color = _clean_color(data.get('color'))
    parent_id = data.get('parentId')
    now = now_ms()
    mentions = parse_mentions(body)
    with transaction.atomic():
        if parent_id is not None:
            parent = BoardComment.objects.select_for_update().filter(pk=parent_id, board_id=board['id'], deleted_at__isnull=True).first() \
                if isinstance(parent_id, str) and re.fullmatch(r'[0-9a-fA-F-]{36}', parent_id) else None
            if parent is None or parent.parent_id is not None:
                raise CommentError('Thread not found.', 404)
            if BoardComment.objects.filter(parent=parent, deleted_at__isnull=True).count() >= MAX_REPLIES_PER_THREAD:
                raise CommentError('This thread is full.', 409)
            fields = {'parent': parent}
        else:
            node, dx, dy, x, y = _anchor(data)
            fields = {'anchor_node_id': node, 'anchor_dx': dx, 'anchor_dy': dy, 'x': x, 'y': y}
            parent = None
        # Live roots and replies together stay within what one full load returns, so a load never drops the newest.
        if BoardComment.objects.filter(board_id=board['id'], deleted_at__isnull=True).count() >= MAX_COMMENTS_PER_BOARD:
            raise CommentError('This board has too many comments.', 409)
        comment = BoardComment.objects.create(board_id=board['id'], author_id=user.id, body=body, color=color if parent is None else None,
                                              mentions=mentions, created_at=now, updated_at=now, **fields)
        thread = parent or comment
        CommentFollow.objects.get_or_create(board_id=board['id'], user_id=user.id, thread=thread)
        notifications.comment_posted(user, board, comment, thread, body, mentions)
        if parent is None:
            _prune(board['id'], now)
        else:
            BoardComment.objects.filter(pk=thread.pk).update(updated_at=now)
    return _serialize(user, [BoardComment.objects.filter(pk=comment.pk).values(*FIELDS).get()])[0]


def _live(board, comment_id):
    row = BoardComment.objects.filter(pk=comment_id, board_id=board['id'], deleted_at__isnull=True).first() \
        if isinstance(comment_id, str) and re.fullmatch(r'[0-9a-fA-F-]{36}', comment_id) else None
    if row is None:
        raise CommentError('Comment not found.', 404)
    return row


def _owned(user, board, comment_id, sharers_too=False):
    """The live comment, for its author; with `sharers_too` (deleting) also for a board sharer or admin.
    Editing is the author's alone: nobody changes words shown under another person's name."""
    row = _live(board, comment_id)
    if row.author_id != user.id and not (sharers_too and access.role_for(user, board) >= access.SHARE):
        raise CommentError('FORBIDDEN', 403)
    return row


def update(user, board, comment_id, data):
    moving = {'anchorNodeId', 'anchorDx', 'anchorDy', 'x', 'y'}
    words = any(key in data for key in ('body', 'color'))
    if words or not any(key in data for key in moving):
        row = _owned(user, board, comment_id)
    else:
        # Where a pin sits is not the author's words: an editor moves it with its object or drags it elsewhere.
        row = _live(board, comment_id)
        if row.author_id != user.id and access.role_for(user, board) < access.EDIT:
            raise CommentError('FORBIDDEN', 403)
    now = now_ms()
    changes = {}
    if 'body' in data:
        body = _clean_body(data['body'])
        changes.update(body=body, mentions=parse_mentions(body), edited_at=now)
    if 'color' in data and row.parent_id is None:
        changes['color'] = _clean_color(data['color'])
    if row.parent_id is None and any(key in data for key in ('anchorNodeId', 'x')):
        node, dx, dy, x, y = _anchor(data)
        changes.update(anchor_node_id=node, anchor_dx=dx, anchor_dy=dy, x=x, y=y)
    if not changes:
        raise CommentError('Nothing to change.')
    with transaction.atomic():
        BoardComment.objects.filter(pk=row.pk).update(updated_at=now, **changes)
        if row.parent_id:
            BoardComment.objects.filter(pk=row.parent_id).update(updated_at=now)
        if 'body' in changes:
            notifications.comment_edited(user, board, row, changes['mentions'], changes['body'])
    return _serialize(user, [BoardComment.objects.filter(pk=row.pk).values(*FIELDS).get()])[0]


def delete(user, board, comment_id):
    row = _owned(user, board, comment_id, sharers_too=True)
    now = now_ms()
    with transaction.atomic():
        gone = models.Q(pk=row.pk) | models.Q(parent=row.pk)
        # A deleted comment's words leave the bell and push too.
        notifications.comments_deleted(list(BoardComment.objects.filter(gone).values_list('pk', flat=True)))
        BoardComment.objects.filter(gone).update(deleted_at=now, updated_at=now)
        if row.parent_id:
            BoardComment.objects.filter(pk=row.parent_id).update(updated_at=now)
    return {'id': str(row.pk)}


def resolve(user, board, comment_id, resolved):
    row = _live(board, comment_id)
    if row.parent_id is not None:
        raise CommentError('Only a thread can be resolved.')
    now = now_ms()
    BoardComment.objects.filter(pk=row.pk).update(updated_at=now, resolved_at=now if resolved else None,
                                                  resolved_by=user.id if resolved else None)
    return _serialize(user, [BoardComment.objects.filter(pk=row.pk).values(*FIELDS).get()])[0]


def react(user, board, comment_id, emoji):
    row = _live(board, comment_id)
    if emoji not in EMOJIS:
        raise CommentError('Unknown reaction.')
    now = now_ms()
    with transaction.atomic():
        removed = CommentReaction.objects.filter(comment=row, user_id=user.id, emoji=emoji).delete()[0]
        if not removed:
            CommentReaction.objects.create(comment=row, user_id=user.id, emoji=emoji, created_at=now)
        BoardComment.objects.filter(pk=row.pk).update(updated_at=now)
    return _serialize(user, [BoardComment.objects.filter(pk=row.pk).values(*FIELDS).get()])[0]


def mark_read(user, board, ids=None, unread=False):
    """Mark the given comments (a thread's, when it is opened) or every comment on the board read, or unread."""
    rows = BoardComment.objects.filter(board_id=board['id'], deleted_at__isnull=True).exclude(author_id=user.id)
    if ids is not None:
        if not isinstance(ids, list) or len(ids) > 500 or not all(isinstance(i, str) and re.fullmatch(r'[0-9a-fA-F-]{36}', i) for i in ids):
            raise CommentError('Invalid ids.')
        rows = rows.filter(pk__in=ids)
    found = list(rows.values_list('pk', flat=True))
    if unread:
        CommentRead.objects.filter(user_id=user.id, comment_id__in=found).delete()
    else:
        CommentRead.objects.bulk_create([CommentRead(user_id=user.id, comment_id=pk) for pk in found], ignore_conflicts=True)
    return {'ids': [str(pk) for pk in found]}


def follow(user, board, thread_id, on):
    """Follow or unfollow one thread, or every thread on the board when `thread_id` is None."""
    thread = _live(board, thread_id) if thread_id is not None else None
    if thread is not None and thread.parent_id is not None:
        raise CommentError('Only a thread can be followed.')
    rows = CommentFollow.objects.filter(board_id=board['id'], user_id=user.id, thread=thread)
    if on:
        rows.exists() or CommentFollow.objects.create(board_id=board['id'], user_id=user.id, thread=thread)
    else:
        rows.delete()
    return follows(user, board)


def suggestions(user, board, limit=8):
    """People the caller has mentioned on this board's comments before, most recent first, then its other authors."""
    seen, ordered = set(), []
    for author, mentions in BoardComment.objects.filter(board_id=board['id']).order_by('-created_at').values_list('author_id', 'mentions')[:400]:
        if author == user.id:
            candidates = (mentions or {}).get('users', [])
        else:
            candidates = [str(author)]
        for candidate in candidates:
            if candidate not in seen and candidate != str(user.id):
                seen.add(candidate)
                ordered.append(candidate)
    live = set(str(pk) for pk in User.objects.filter(pk__in=ordered, is_active=True).values_list('pk', flat=True))
    return [candidate for candidate in ordered if candidate in live][:limit]


def heartbeat(user, board, now=None):
    """Record that the user is on the board and return who is: everyone seen in the last PRESENCE_MS, newest first."""
    now = now_ms() if now is None else now
    BoardPresence.objects.update_or_create(board_id=board['id'], user_id=user.id, defaults={'seen_at': now})
    return [{'userId': str(uid), 'seenAt': seen} for uid, seen in
            BoardPresence.objects.filter(board_id=board['id'], seen_at__gte=now - PRESENCE_MS).order_by('-seen_at').values_list('user_id', 'seen_at')[:100]]


def pulse(user, board, since):
    """One board poll: the caller's presence beat and the people on the board, comments changed since `since`,
    and the caller's unread notification count."""
    now = now_ms()
    return {'now': now, 'people': heartbeat(user, board, now), 'comments': list_comments(user, board, since),
            'unread': notifications.unread_count(user)}
