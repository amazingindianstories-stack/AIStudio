from django.contrib.postgres.functions import RandomUUID
from apps.common.indexes import PostgreSQLIndex
from django.db import models


class MediaExport(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user_id = models.UUIDField()
    status = models.TextField(default="draft", db_default='draft')
    total_items = models.IntegerField(default=0, db_default=0)
    processed_items = models.IntegerField(default=0, db_default=0)
    skipped_items = models.IntegerField(default=0, db_default=0)
    warnings = models.JSONField(default=list, db_default=[])
    attempt_count = models.IntegerField(default=0, db_default=0)
    lease_owner = models.TextField(null=True)
    lease_until = models.BigIntegerField(null=True)
    output_key = models.TextField(null=True)
    output_bytes = models.BigIntegerField(null=True)
    error = models.TextField(null=True)
    manifest_version = models.IntegerField(default=1, db_default=1)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    expires_at = models.BigIntegerField(null=True)

    class Meta:
        managed = True
        db_table = 'media_exports'
        indexes = [
            PostgreSQLIndex(models.F('user_id').asc(nulls_last=True), models.F('created_at').desc(nulls_last=True), name='media_exports_user_created_idx'),
            PostgreSQLIndex(models.F('status').asc(nulls_last=True), models.F('lease_until').asc(nulls_last=True), models.F('created_at').asc(nulls_last=True), name='media_exports_worker_due_idx'),
        ]

class MediaExportItem(models.Model):
    pk = models.CompositePrimaryKey('export_id', 'generation_id')
    export = models.ForeignKey(MediaExport, on_delete=models.CASCADE, db_column='export_id', db_index=False)
    generation_id = models.UUIDField()
    position = models.IntegerField()
    source_key = models.TextField()
    filename = models.TextField()

    class Meta:
        managed = True
        db_table = 'media_export_items'
        indexes = [
            PostgreSQLIndex(models.F('export').asc(nulls_last=True), models.F('position').asc(nulls_last=True), name='media_export_items_order_idx'),
        ]
