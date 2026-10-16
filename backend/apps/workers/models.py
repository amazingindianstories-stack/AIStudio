from django.contrib.postgres.functions import RandomUUID
from django.db import models


class DepthWorker(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    worker_id = models.TextField(unique=True)
    label = models.TextField(null=True)
    device = models.TextField(null=True)
    status = models.TextField(default="idle", db_default='idle')
    current_job_id = models.UUIDField(null=True)
    current_claim_id = models.UUIDField(null=True)
    protocol_version = models.IntegerField(default=1, db_default=1)
    ram_limit_mb = models.IntegerField(null=True)
    ram_used_mb = models.IntegerField(null=True)
    last_seen_at = models.BigIntegerField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'depth_workers'
