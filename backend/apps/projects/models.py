"""Mirrors src/lib/schema.js `projects`/`folders`. managed = TEST_MANAGED
— see apps/common/db_flags.py and the backend/ section of CLAUDE.md."""

import uuid

from django.db import models

from apps.common.db_flags import TEST_MANAGED


class Project(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    name = models.TextField()
    brief = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "projects"


class Folder(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    project_id = models.UUIDField()
    name = models.TextField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "folders"
