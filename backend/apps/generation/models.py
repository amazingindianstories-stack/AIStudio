"""Mirrors src/lib/schema.js `generations`/`pricing`. managed = TEST_MANAGED
— see apps/common/db_flags.py and the backend/ section of CLAUDE.md."""

import uuid

from django.db import models

from apps.common.db_flags import TEST_MANAGED


class Generation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    kind = models.TextField()  # 'image' | 'video'
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
