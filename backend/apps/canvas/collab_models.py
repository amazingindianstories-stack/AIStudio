"""Board collaboration tables: comments, reactions, read markers, thread follows, the notification feed,
board presence and Web Push subscriptions. They live outside the board JSON, so its 2 Mi cap is untouched."""
from django.contrib.postgres.functions import RandomUUID
from django.db import models

COLLAB_TOOL_LEVELS = ('edit', 'owner')
NOTIFICATION_KINDS = ('comment', 'reply', 'mention')


class BoardComment(models.Model):
    """One comment. A root carries the anchor (a node id plus an offset from it, else board coordinates);
    replies point at the root with ``parent``. A deleted comment stays as a tombstone (``deleted_at``) so open
    boards polling for changes drop it; the tombstone is pruned a day later."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board_id = models.UUIDField()
    parent = models.ForeignKey('self', on_delete=models.CASCADE, null=True, db_column='parent_id', db_index=False)
    author_id = models.UUIDField()
    body = models.TextField()
    color = models.TextField(null=True)
    anchor_node_id = models.TextField(null=True)
    anchor_dx = models.FloatField(null=True)
    anchor_dy = models.FloatField(null=True)
    x = models.FloatField(null=True)
    y = models.FloatField(null=True)
    mentions = models.JSONField(null=True)
    resolved_at = models.BigIntegerField(null=True)
    resolved_by = models.UUIDField(null=True)
    deleted_at = models.BigIntegerField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    edited_at = models.BigIntegerField(null=True)

    class Meta:
        managed = True
        db_table = 'board_comments'
        indexes = [models.Index(fields=['board_id', 'updated_at'], name='board_comments_board_idx'),
                   models.Index(fields=['parent'], name='board_comments_parent_idx')]


class CommentReaction(models.Model):
    pk = models.CompositePrimaryKey('comment_id', 'user_id', 'emoji')
    comment = models.ForeignKey(BoardComment, on_delete=models.CASCADE, db_column='comment_id', db_index=False)
    user_id = models.UUIDField()
    emoji = models.TextField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'board_comment_reactions'


class CommentRead(models.Model):
    """A comment this user has read (their own are never unread)."""
    pk = models.CompositePrimaryKey('user_id', 'comment_id')
    user_id = models.UUIDField()
    comment = models.ForeignKey(BoardComment, on_delete=models.CASCADE, db_column='comment_id', db_index=False)

    class Meta:
        managed = True
        db_table = 'board_comment_reads'
        indexes = [models.Index(fields=['comment'], name='comment_reads_comment_idx')]


class CommentFollow(models.Model):
    """A user's follow of one thread (``thread`` set) or of every thread on a board (``thread`` null)."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board_id = models.UUIDField()
    user_id = models.UUIDField()
    thread = models.ForeignKey(BoardComment, on_delete=models.CASCADE, null=True, db_column='thread_id', db_index=False)

    class Meta:
        managed = True
        db_table = 'board_comment_follows'
        indexes = [models.Index(fields=['board_id', 'user_id'], name='board_comment_follows_idx')]
        constraints = [
            models.UniqueConstraint(fields=('board_id', 'user_id', 'thread'), name='board_comment_follows_thread_key',
                                    condition=models.Q(thread__isnull=False)),
            models.UniqueConstraint(fields=('board_id', 'user_id'), name='board_comment_follows_all_key',
                                    condition=models.Q(thread__isnull=True))]


class Notification(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user_id = models.UUIDField()
    board_id = models.UUIDField()
    kind = models.TextField()
    comment_id = models.UUIDField(null=True)
    thread_id = models.UUIDField(null=True)
    actor_id = models.UUIDField(null=True)
    snippet = models.TextField(null=True)
    created_at = models.BigIntegerField()
    read_at = models.BigIntegerField(null=True)
    pushed_at = models.BigIntegerField(null=True)

    class Meta:
        managed = True
        db_table = 'board_notifications'
        indexes = [models.Index(fields=['user_id', '-created_at'], name='board_notifications_user_idx'),
                   models.Index(fields=['pushed_at', 'created_at'], name='board_notifications_push_idx'),
                   models.Index(fields=['created_at'], name='notifications_created_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(kind__in=NOTIFICATION_KINDS), name='board_notifications_kind_check')]


class BoardPresence(models.Model):
    pk = models.CompositePrimaryKey('board_id', 'user_id')
    board_id = models.UUIDField()
    user_id = models.UUIDField()
    seen_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'board_presence'
        indexes = [models.Index(fields=['seen_at'], name='board_presence_seen_idx')]


class PushSubscription(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user_id = models.UUIDField()
    endpoint = models.TextField(unique=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'push_subscriptions'
        indexes = [models.Index(fields=['user_id'], name='push_subscriptions_user_idx')]
