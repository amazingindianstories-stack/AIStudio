from django.db import models


class MediaExport(models.Model):
    id = models.UUIDField(primary_key=True)
    user_id = models.UUIDField()
    status = models.TextField(default="draft")
    total_items = models.IntegerField(default=0)
    processed_items = models.IntegerField(default=0)
    skipped_items = models.IntegerField(default=0)
    warnings = models.JSONField(default=list)
    attempt_count = models.IntegerField(default=0)
    lease_owner = models.TextField(null=True)
    lease_until = models.BigIntegerField(null=True)
    output_key = models.TextField(null=True)
    output_bytes = models.BigIntegerField(null=True)
    error = models.TextField(null=True)
    manifest_version = models.IntegerField(default=1)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    expires_at = models.BigIntegerField(null=True)

    class Meta:
        managed = False
        db_table = 'media_exports'

class MediaExportItem(models.Model):
    pk = models.CompositePrimaryKey('export_id', 'generation_id')
    export = models.ForeignKey(MediaExport, on_delete=models.CASCADE, db_column='export_id')
    generation_id = models.UUIDField()
    position = models.IntegerField()
    source_key = models.TextField()
    filename = models.TextField()

    class Meta:
        managed = False
        db_table = 'media_export_items'
