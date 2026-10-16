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


class ManagedPortraitPool(models.Model):
    """Singleton state of the automatic BytePlus portrait pool (one managed asset group)."""
    id = models.IntegerField(primary_key=True, default=1)
    byteplus_group_id = models.TextField(null=True)
    observed_capacity = models.IntegerField(null=True)      # live count seen when BytePlus last reported quota
    last_quota_error_at = models.BigIntegerField(null=True)
    updated_at = models.BigIntegerField()
    class Meta:
        managed = True
        db_table = 'managed_portrait_pool'


class ManagedPortraitAsset(models.Model):
    """A reference image with a face, registered automatically as a BytePlus asset."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    content_sha256 = models.TextField()
    source_key = models.TextField()                  # original in our storage (never modified)
    registered_key = models.TextField(null=True)     # derived copy when the original is outside BytePlus bounds
    byteplus_asset_id = models.TextField(null=True, unique=True)
    status = models.TextField()                      # REGISTERING PROCESSING ACTIVE DELETING DELETED FAILED UNCERTAIN
    receipt = models.JSONField(db_default={})
    error_code = models.TextField(null=True)
    created_by_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    last_used_at = models.BigIntegerField()
    expires_at = models.BigIntegerField(null=True)
    deleted_at = models.BigIntegerField(null=True)
    class Meta:
        managed = True
        db_table = 'managed_portrait_assets'
        indexes = [
            PostgreSQLIndex(models.F('status').asc(nulls_last=True), models.F('last_used_at').asc(nulls_last=True), name='managed_portrait_assets_lru_idx'),
            PostgreSQLIndex(models.F('expires_at').asc(nulls_last=True), name='managed_portrait_assets_expiry_idx'),
        ]
        constraints = [
            models.UniqueConstraint(fields=['content_sha256'], condition=~models.Q(status__in=['DELETED', 'FAILED']),
                                    name='managed_portrait_assets_live_sha_uniq'),
        ]


class ManagedPortraitPin(models.Model):
    """While a pin exists the asset is in use by that generation and is never expired or evicted."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    generation_id = models.UUIDField()
    asset = models.ForeignKey(ManagedPortraitAsset, on_delete=models.PROTECT, db_column='asset_id', db_index=False)
    pinned_at = models.BigIntegerField()
    class Meta:
        managed = True
        db_table = 'managed_portrait_pins'
        indexes = [PostgreSQLIndex(models.F('asset_id').asc(nulls_last=True), name='managed_portrait_pins_asset_idx')]
        constraints = [models.UniqueConstraint(fields=['generation_id', 'asset'], name='managed_portrait_pins_uniq')]


class ReferenceFaceScan(models.Model):
    content_sha256 = models.TextField(primary_key=True)
    has_face = models.BooleanField()
    faces = models.IntegerField()
    detector_version = models.TextField()
    error = models.TextField(null=True)
    scanned_at = models.BigIntegerField()
    class Meta:
        managed = True
        db_table = 'reference_face_scans'


class ManagedPortraitWait(models.Model):
    """When a generation started waiting for portrait space (for the admin wait limit)."""
    generation_id = models.UUIDField(primary_key=True)
    started_at = models.BigIntegerField()
    reason = models.TextField()
    class Meta:
        managed = True
        db_table = 'managed_portrait_waits'
