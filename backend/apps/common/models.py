from apps.common.indexes import PostgreSQLIndex
from django.db import models

class ActivityLog(models.Model):
    id = models.UUIDField(primary_key=True)
    user_id = models.UUIDField(null=True)
    action = models.TextField()
    detail = models.JSONField(null=True)
    created_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'activity_logs'
        indexes = [
            PostgreSQLIndex(models.F('created_at').asc(nulls_last=True), name='activity_logs_created_at_idx'),
        ]
