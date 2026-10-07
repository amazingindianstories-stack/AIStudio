from django.db import models

class Folder(models.Model):
    id = models.UUIDField(primary_key=True)
    project_id = models.UUIDField(null=True)
    parent_id = models.UUIDField(null=True)
    name = models.TextField()
    name_normalized = models.TextField()
    version = models.IntegerField()
    color = models.TextField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'folders'
