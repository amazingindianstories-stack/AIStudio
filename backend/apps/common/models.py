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
