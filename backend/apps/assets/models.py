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
