from django.contrib.postgres.functions import RandomUUID
from django.contrib.postgres.indexes import GinIndex
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
    # Who may start collaboration tools (timer, voting, attention): every editor, or owners and co-owners.
    collab_tools = models.TextField(db_default='edit')

    class Meta:
        managed = True
        db_table = 'canvas_boards'
        indexes = [models.Index(fields=['project_id'], name='canvas_boards_project_id_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(team_role__in=BOARD_ROLES), name='canvas_boards_team_role_check'),
                       models.CheckConstraint(condition=models.Q(collab_tools__in=('edit', 'owner')), name='canvas_boards_collab_tools_check')]


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
    # The ids of the nodes and connectors the save changed ({"nodes": [...], "connectors": [...]}), so open
    # boards fetch only those (apps.canvas.patch); null when it changed too many or was saved before this.
    changes = models.JSONField(null=True)

    class Meta:
        managed = True
        db_table = 'canvas_board_saves'
        indexes = [models.Index(fields=['applied_at'], name='canvas_board_saves_applied_idx'),
                   models.Index(fields=['board_id', 'version'], name='canvas_board_saves_version_idx')]
        constraints = [models.UniqueConstraint(fields=('board_id', 'save_id'), name='canvas_board_saves_board_save_key')]


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


ACTIVITY_ACTIONS = ('add', 'edit', 'delete')


class BoardActivity(models.Model):
    """One object a graph save added, edited or deleted (moves are not recorded), kept
    ACTIVITY_RETENTION_MS; written in the save's transaction by apps.canvas.activity."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board_id = models.UUIDField()
    actor_id = models.UUIDField(null=True)
    action = models.TextField()
    node_id = models.TextField()
    node_type = models.TextField()
    snippet = models.TextField(null=True)
    # The save's time and the change's position in that save, the History panel's keyset.
    created_at = models.BigIntegerField()
    ordinal = models.IntegerField()

    class Meta:
        managed = True
        db_table = 'board_activity'
        indexes = [models.Index(fields=['board_id', '-created_at', '-ordinal'], name='board_activity_board_idx'),
                   models.Index(fields=['created_at'], name='board_activity_created_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(action__in=ACTIVITY_ACTIONS), name='board_activity_action_check')]


class CustomShapePack(models.Model):
    """User-uploaded custom SVG shape pack, optionally shared with the organisation."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    name = models.TextField()
    created_by = models.UUIDField()
    shared = models.BooleanField(db_default=False)
    show_names = models.BooleanField(db_default=True)
    shapes = models.JSONField()
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_custom_shape_packs'
        indexes = [models.Index(fields=['created_by'], name='canvas_shape_packs_creator_idx'),
                   models.Index(fields=['shared', 'updated_at'], name='canvas_shape_packs_shared_idx')]


class WorkTable(models.Model):
    """Shared records and views; board nodes carry only this id and their geometry."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board = models.ForeignKey(CanvasBoard, on_delete=models.CASCADE)
    name = models.TextField()
    fields = models.JSONField()
    views = models.JSONField(default=list)
    owner_id = models.UUIDField()
    owner_only = models.BooleanField(default=False)
    version = models.PositiveBigIntegerField(default=1)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        db_table = 'canvas_work_tables'


class WorkRecord(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    table = models.ForeignKey(WorkTable, on_delete=models.CASCADE, related_name='records')
    cells = models.JSONField()
    parent = models.ForeignKey('self', on_delete=models.SET_NULL, null=True, related_name='children')
    position = models.PositiveIntegerField(default=0)
    version = models.PositiveBigIntegerField(default=1)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        db_table = 'canvas_work_records'
        indexes = [GinIndex(fields=['cells'], name='work_records_cells_gin_idx', opclasses=['jsonb_path_ops']),
                   models.Index(fields=['table', 'position', 'id'], name='work_record_table_order_idx'),
                   models.Index(fields=['table', 'updated_at'], name='work_record_table_updated_idx')]


class WorkRelation(models.Model):
    source = models.ForeignKey(WorkRecord, on_delete=models.CASCADE, related_name='dependencies')
    target = models.ForeignKey(WorkRecord, on_delete=models.CASCADE, related_name='dependents')
    kind = models.TextField(default='blocked_by')

    class Meta:
        db_table = 'canvas_work_relations'
        constraints = [models.UniqueConstraint(fields=['source', 'target', 'kind'], name='work_relation_unique'),
                       models.CheckConstraint(condition=~models.Q(source=models.F('target')), name='work_relation_not_self'),
                       models.CheckConstraint(condition=models.Q(kind__in=['blocked_by', 'relation']), name='work_relation_kind_check')]


class WorkHistory(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    table = models.ForeignKey(WorkTable, on_delete=models.CASCADE)
    actor_id = models.UUIDField()
    target_id = models.TextField()
    action = models.TextField()
    before = models.JSONField(null=True)
    after = models.JSONField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        db_table = 'canvas_work_history'
        indexes = [models.Index(fields=['table', '-created_at', '-id'], name='work_history_table_time_idx')]


class BoardNotification(models.Model):
    """Generic in-app delivery. Recipients are re-authorized on every inbox read."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    actor_id = models.UUIDField(null=True)
    board = models.ForeignKey(CanvasBoard, on_delete=models.CASCADE)
    kind = models.TextField()
    target_id = models.TextField()
    payload = models.JSONField(default=dict)
    event_key = models.TextField(unique=True)
    created_at = models.BigIntegerField()
    read_at = models.BigIntegerField(null=True)

    class Meta:
        db_table = 'board_notifications'
        indexes = [models.Index(fields=['user', '-created_at'], name='board_notifications_user_idx')]


class BoardNotificationPreference(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, primary_key=True)
    preferences = models.JSONField(default=dict)

    class Meta:
        db_table = 'board_notification_preferences'


class BoardMedia(models.Model):
    """Durable reusable board files; heavyweight rasterization runs in the generation worker."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    board = models.ForeignKey(CanvasBoard, on_delete=models.CASCADE, db_index=False)
    actor_id = models.UUIDField()
    reference_id = models.UUIDField(null=True)
    name = models.TextField()
    content_type = models.TextField()
    source_key = models.TextField()
    key = models.TextField(default='')
    state = models.TextField(default='queued')
    pages = models.IntegerField(default=1)
    width = models.IntegerField(default=0)
    height = models.IntegerField(default=0)
    error = models.TextField(default='')
    lease_until = models.BigIntegerField(default=0)
    lease_token = models.UUIDField(null=True)
    attempts = models.IntegerField(default=0)
    created_at = models.BigIntegerField()

    class Meta:
        db_table = 'canvas_board_media'
        indexes = [models.Index(fields=['state', 'created_at'], name='canvas_media_queue_idx'),
                   models.Index(fields=['board', '-created_at'], name='canvas_media_board_idx')]
        constraints = [models.UniqueConstraint(fields=['board', 'reference_id'], name='canvas_media_upload_uniq'),
                       models.CheckConstraint(condition=models.Q(state__in=('queued', 'running', 'ready', 'failed')),
                                              name='canvas_media_state_check')]



TEMPLATE_SCOPES = ('personal', 'project', 'everyone')


class BoardTemplate(models.Model):
    """A custom board template: a board v1 graph kept apart from the board it came from. Soft deleted
    (``deleted_at``) so the delete toast can undo. ``board_id`` is the ordinary board a template is edited in."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    name = models.TextField()
    description = models.TextField(db_default='')
    category = models.TextField(db_default='other')
    tags = models.JSONField(default=list)
    scope = models.TextField(db_default='personal')
    # The project a 'project' scoped template is visible in.
    project_id = models.UUIDField(null=True)
    created_by = models.UUIDField(null=True)
    featured = models.BooleanField(db_default=False)
    graph = models.JSONField()
    # A few normalized rectangles the picker draws as the thumbnail; never the graph itself.
    preview = models.JSONField(default=dict)
    node_count = models.IntegerField(db_default=0)
    board_id = models.UUIDField(null=True)
    # The Format a template opens in (Table, Timeline, Doc, Slides, Diagram); the Formats slice reads it.
    default_view = models.TextField(null=True)
    deleted_at = models.BigIntegerField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_board_templates'
        indexes = [models.Index(fields=['scope', 'project_id'], name='canvas_templates_scope_idx'),
                   models.Index(fields=['created_by'], name='canvas_templates_creator_idx'),
                   models.Index(fields=['board_id'], name='canvas_templates_board_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(scope__in=TEMPLATE_SCOPES), name='canvas_templates_scope_check')]


class Blueprint(models.Model):
    """A custom blueprint: the boards of a project as graph snapshots, to start a new project from."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    name = models.TextField()
    description = models.TextField(db_default='')
    scope = models.TextField(db_default='personal')
    project_id = models.UUIDField(null=True)
    created_by = models.UUIDField(null=True)
    featured = models.BooleanField(db_default=False)
    # [{"name": ..., "graph": {...}}], one per board.
    boards = models.JSONField()
    deleted_at = models.BigIntegerField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_blueprints'
        indexes = [models.Index(fields=['scope', 'project_id'], name='canvas_blueprints_scope_idx')]
        constraints = [models.CheckConstraint(condition=models.Q(scope__in=TEMPLATE_SCOPES), name='canvas_blueprints_scope_check')]


class BoardTemplateUsage(models.Model):
    """One insertion of a template (shipped or custom) or one blueprint use, for the admin counts."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    # 'builtin:<slug>' for shipped content, the row id for custom templates and blueprints.
    template_ref = models.TextField()
    kind = models.TextField()
    name = models.TextField()
    user_id = models.UUIDField(null=True)
    board_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_template_usage'
        indexes = [models.Index(fields=['created_at'], name='canvas_template_usage_at_idx'),
                   models.Index(fields=['template_ref', 'created_at'], name='canvas_template_usage_ref_idx')]


class BoardTemplateLike(models.Model):
    pk = models.CompositePrimaryKey('template_ref', 'user_id')
    template_ref = models.TextField()
    user_id = models.UUIDField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_template_likes'
        indexes = [models.Index(fields=['user_id'], name='canvas_template_likes_user_idx')]


class BoardTemplateComment(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    template_ref = models.TextField()
    user_id = models.UUIDField(null=True)
    body = models.TextField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'canvas_template_comments'
        indexes = [models.Index(fields=['template_ref', 'created_at'], name='canvas_template_comments_idx')]


from .collab_models import (BoardComment, BoardPresence, CommentFollow, CommentRead, CommentReaction, Notification, PushSubscription)  # noqa: E402,F401
