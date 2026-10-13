from django.contrib.postgres.functions import RandomUUID
from apps.common.indexes import PostgreSQLIndex
from django.db import models

class Asset(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    created_by_id = models.UUIDField(null=True)
    kind = models.TextField()
    name = models.TextField()
    slug = models.TextField()
    description = models.TextField(null=True)
    images = models.JSONField(db_default=[])
    project_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = True
        db_table = 'assets'
        indexes = [
            PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), name='assets_project_id_idx'),
        ]


class PortraitGroup(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    byteplus_group_id = models.TextField(null=True, unique=True)
    name = models.TextField()
    description = models.TextField(null=True)
    group_type = models.TextField(default='AIGC', db_default='AIGC')
    project_name = models.TextField(default='default', db_default='default')
    primary_asset_id = models.TextField(null=True)
    project_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'portrait_groups'
        indexes = [models.Index(fields=['project_id'], name='portrait_groups_project_id_idx')]


class PortraitAsset(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    created_by_id = models.UUIDField(null=True)
    group = models.ForeignKey(PortraitGroup, on_delete=models.CASCADE, db_column='group_id', db_index=False)
    byteplus_asset_id = models.TextField(null=True, unique=True)
    name = models.TextField(null=True)
    asset_type = models.TextField(default='Image', db_default='Image')
    role = models.TextField(default='reference', db_default='reference')
    image_url = models.TextField()
    status = models.TextField(default='Processing', db_default='Processing')
    status_message = models.TextField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'portrait_assets'
