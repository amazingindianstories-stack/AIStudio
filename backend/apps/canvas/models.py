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


class BoardAiJob(models.Model):
    """One "Create with AI" request on a board: the format asked for and the generation that runs it.

    The generation worker executes the generation row (a text job for sticky notes, an image job for an image) under
    the usual admission, spend window and paid guard; this row only ties it to the board, the refine chain and the
    nodes the board placed for it. ``generation_id`` has no foreign key, so deleting the image from the library
    leaves the job (and its placed node) alone."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board = models.ForeignKey(CanvasBoard, on_delete=models.CASCADE, db_column='board_id', db_index=False)
    user_id = models.UUIDField()
    format = models.TextField()
    prompt = models.TextField()
    generation_id = models.UUIDField(unique=True)
    parent_job = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, db_column='parent_job_id', db_index=False)
    placed_node_ids = models.JSONField(null=True)
    placed_at = models.BigIntegerField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_board_ai_jobs'
        indexes = [models.Index(fields=['board', 'user_id', 'created_at'], name='canvas_ai_jobs_board_user_idx'),
                   models.Index(fields=['parent_job'], name='canvas_ai_jobs_parent_idx')]
