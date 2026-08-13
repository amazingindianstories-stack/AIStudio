"""Mirrors src/lib/schema.js `assets`. managed = TEST_MANAGED — see
apps/common/db_flags.py and the backend/ section of CLAUDE.md."""

import uuid

from django.db import models

from apps.common.db_flags import TEST_MANAGED


class Asset(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    kind = models.TextField()
    name = models.TextField()
    slug = models.TextField()
    description = models.TextField(null=True)
    images = models.JSONField(default=list)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "assets"
