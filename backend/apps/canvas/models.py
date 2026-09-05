"""Mirrors src/lib/schema.js `canvas_boards`. managed = TEST_MANAGED — see
apps/common/db_flags.py and the backend/ section of CLAUDE.md."""

import uuid

from django.db import models

class CanvasBoard(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    project_id = models.UUIDField()
    name = models.TextField()
    data = models.JSONField()
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        db_table = "canvas_boards"
        indexes = [models.Index(fields=["project_id"], name="canvas_boards_project_id_idx")]
