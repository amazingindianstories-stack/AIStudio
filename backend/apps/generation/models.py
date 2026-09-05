"""Django-owned models for the generation and pricing tables."""

import uuid

from django.db import models

from apps.common.indexes import PostgresIndex

class Generation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    kind = models.TextField()  # 'image' | 'video' | 'depth'
    status = models.TextField()
    prompt = models.TextField()
    model = models.TextField()
    aspect_ratio = models.TextField()
    resolution = models.TextField(null=True)
    duration = models.IntegerField(null=True)
    url = models.TextField(null=True)
    poster = models.TextField(null=True)
    error = models.TextField(null=True)
    moderation_blocked = models.BooleanField(null=True)
    reference_images = models.JSONField(null=True)
    reference_videos = models.JSONField(null=True)
    project_id = models.UUIDField(null=True)
    folder_id = models.UUIDField(null=True)
    user_id = models.UUIDField(null=True)
    cost_cents = models.IntegerField(default=0)
    cost_basis = models.TextField(default="estimated")
    is_favorite = models.BooleanField(default=False)
    favorited_at = models.BigIntegerField(null=True)
    task_id = models.TextField(null=True)
    poll_error_count = models.IntegerField(default=0)
    last_poll_error_at = models.BigIntegerField(null=True)
    generate_audio = models.BooleanField(null=True)
    video_task_mode = models.TextField(null=True)
    # Depth-map jobs only (kind='depth') — see schema.js's generations table
    # for why these are worker-reported columns rather than an in-request
    # value like image/video's status fields.
    progress_percent = models.IntegerField(null=True)
    progress_message = models.TextField(null=True)
    # See schema.js's trackCharacters comment — YOLOv8-seg person tracking
    # composited onto the depth map, worker-side toggle.
    track_characters = models.BooleanField(null=True)
    # Reproducibility seed (Phase 3.1) — mirrors schema.js's `seed` column
    # verbatim, see that file's comment for the full semantics (only filled
    # in for models config.supports_seed confirms; null means "not asked" or
    # "unsupported").
    seed = models.IntegerField(null=True)
    # Video best-of-N task ids, settled by video_reconciliation.py.
    candidate_task_ids = models.JSONField(null=True)
    # Multi-shot chaining (Phase 3.3) — mirrors schema.js's
    # `continuation_frame_url`. A stored media URL for a frame extracted from
    # a previous generation, submitted as the new video's starting frame.
    continuation_frame_url = models.TextField(null=True)
    # Lightweight quality feedback signal (Phase 3.5) — mirrors schema.js's
    # `flagged`/`flagged_at`/`flag_reason`/`judge_score` verbatim. Independent
    # of is_favorite (see that file's comment). judge_score is the winning
    # best-of-N candidate's face-judge score, captured at generation time —
    # written by the queue and video reconciliation paths.
    flagged = models.BooleanField(default=False)
    flagged_at = models.BigIntegerField(null=True)
    flag_reason = models.TextField(null=True)
    judge_score = models.JSONField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        db_table = "generations"
        indexes = [
            models.Index(fields=["created_at"], name="generations_created_at_idx"),
            models.Index(fields=["status", "kind", "created_at"], name="generations_queue_idx"),
            models.Index(fields=["project_id"], name="generations_project_id_idx"),
            models.Index(fields=["folder_id"], name="generations_folder_id_idx"),
            models.Index(fields=["user_id", "created_at"], name="generations_user_created_idx"),
            models.Index(fields=["-created_at", "-id"], name="generations_created_keyset_idx"),
            models.Index(fields=["project_id", "-created_at", "-id"], name="generations_project_keyset_idx"),
            models.Index(fields=["folder_id", "-created_at", "-id"], name="generations_folder_keyset_idx"),
            PostgresIndex(fields=["-favorited_at", "-id"], name="generations_favorite_keyset_idx", condition=models.Q(is_favorite=True)),
            models.Index(fields=["-flagged_at", "-id"], name="generations_flagged_keyset_idx", condition=models.Q(flagged=True)),
            PostgresIndex(
                fields=["updated_at", "created_at", "id"],
                name="generations_stale_video_poll_idx",
                condition=models.Q(kind="video", status__in=["queued", "running"], task_id__isnull=False),
            ),
        ]


class Pricing(models.Model):
    model = models.TextField(primary_key=True, db_column="model")
    unit_cost_cents = models.IntegerField()
    unit = models.TextField()  # 'per_image' | 'per_second'
    notes = models.TextField(null=True)

    class Meta:
        db_table = "pricing"


class DepthWorker(models.Model):
    """Mirrors schema.js's depth_workers table — see that file's docstring
    for the "online" derivation and why workerId (not row id) is the stable
    upsert key."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    worker_id = models.TextField(unique=True)
    label = models.TextField(null=True)
    device = models.TextField(null=True)
    status = models.TextField(default="idle")
    current_job_id = models.UUIDField(null=True)
    ram_limit_mb = models.IntegerField(null=True)
    ram_used_mb = models.IntegerField(null=True)
    last_seen_at = models.BigIntegerField()
    created_at = models.BigIntegerField()

    class Meta:
        db_table = "depth_workers"
