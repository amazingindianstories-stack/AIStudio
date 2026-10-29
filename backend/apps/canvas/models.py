from django.contrib.postgres.functions import RandomUUID
from django.db import models
from apps.authentication.models import User

BOARD_ROLES = ('edit', 'comment', 'view')


class CanvasBoard(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    project_id = models.UUIDField()
    name = models.TextField()
    data = models.JSONField()
    # The board owner; owner powers live in apps.canvas.access.
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    # What every signed-in teammate gets without an explicit membership.
    team_role = models.TextField(db_default='edit')
    # Bumped by every graph save; editors send the version they started from.
    version = models.BigIntegerField(db_default=1)

    class Meta:
        managed = True
        db_table = 'canvas_boards'
        indexes = [models.Index(fields=['project_id'], name='canvas_boards_project_id_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(team_role__in=BOARD_ROLES), name='canvas_boards_team_role_check')]


class BoardMember(models.Model):
    pk = models.CompositePrimaryKey('board_id', 'user_id')
    board = models.ForeignKey(CanvasBoard, on_delete=models.CASCADE, db_index=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, db_index=False)
    role = models.TextField()
    added_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'board_members'
        indexes = [models.Index(fields=['user'], name='board_members_user_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(role__in=BOARD_ROLES), name='board_members_role_check')]


class CanvasBoardSave(models.Model):
    """A client save id a board applied, kept SAVE_RETENTION_MS so a draft left behind by a save that
    landed (its response lost) is recognised and not replayed over other people's later edits."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board_id = models.UUIDField()
    save_id = models.UUIDField()
    version = models.BigIntegerField()
    applied_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_board_saves'
        indexes = [models.Index(fields=['applied_at'], name='canvas_board_saves_applied_idx')]
        constraints = [models.UniqueConstraint(fields=('board_id', 'save_id'), name='canvas_board_saves_board_save_key')]
