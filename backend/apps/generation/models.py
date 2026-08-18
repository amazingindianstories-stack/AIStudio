"""Mirrors src/lib/schema.js `generations`/`pricing`. managed = TEST_MANAGED
— see apps/common/db_flags.py and the backend/ section of CLAUDE.md."""

import uuid

from django.db import models

from apps.common.db_flags import TEST_MANAGED


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
    is_favorite = models.BooleanField(default=False)
    favorited_at = models.BigIntegerField(null=True)
    task_id = models.TextField(null=True)
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
    # Video best-of-N (Phase 3.2) — mirrors schema.js's `candidate_task_ids`
    # column. NOT wired into any Django view (the queue/execute + video
    # status-poll changes for this phase were only built on the Next.js
    # side — see generation_views.py's own note; Django isn't live yet and
    # this feature additionally needs a real ffmpeg binary in the runtime,
    # which this backend has no equivalent of). Column exists so the model
    # stays a faithful mirror of the live table regardless of which app
    # wrote a given row.
    candidate_task_ids = models.JSONField(null=True)
    # Multi-shot chaining (Phase 3.3) — mirrors schema.js's
    # `continuation_frame_url`. A stored media URL for a frame extracted from
    # a previous generation, submitted as the new video's starting frame.
    continuation_frame_url = models.TextField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "generations"


class Pricing(models.Model):
    model = models.TextField(primary_key=True, db_column="model")
    unit_cost_cents = models.IntegerField()
    unit = models.TextField()  # 'per_image' | 'per_second'
    notes = models.TextField(null=True)

    class Meta:
        managed = TEST_MANAGED
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
        managed = TEST_MANAGED
        db_table = "depth_workers"
