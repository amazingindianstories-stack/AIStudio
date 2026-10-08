from django.db import models

class Asset(models.Model):
    id = models.UUIDField(primary_key=True)
    kind = models.TextField()
    name = models.TextField()
    slug = models.TextField()
    description = models.TextField(null=True)
    images = models.JSONField()
    project_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'assets'


class PortraitGroup(models.Model):
    id = models.UUIDField(primary_key=True)
    byteplus_group_id = models.TextField(null=True, unique=True)
    name = models.TextField()
    description = models.TextField(null=True)
    group_type = models.TextField(default='AIGC')
    project_name = models.TextField(default='default')
    primary_asset_id = models.TextField(null=True)
    project_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'portrait_groups'
        indexes = [models.Index(fields=['project_id'], name='portrait_groups_project_id_idx')]


class PortraitAsset(models.Model):
    id = models.UUIDField(primary_key=True)
    group = models.ForeignKey(PortraitGroup, on_delete=models.CASCADE, db_column='group_id')
    byteplus_asset_id = models.TextField(null=True, unique=True)
    name = models.TextField(null=True)
    asset_type = models.TextField(default='Image')
    role = models.TextField(default='reference')
    image_url = models.TextField()
    status = models.TextField(default='Processing')
    status_message = models.TextField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'portrait_assets'
