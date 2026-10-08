from django.contrib.postgres.functions import RandomUUID
from django.db import models


class CanvasBoard(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    project_id = models.UUIDField()
    name = models.TextField()
    data = models.JSONField()
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'canvas_boards'
        indexes = [models.Index(fields=['project_id'], name='canvas_boards_project_id_idx')]
