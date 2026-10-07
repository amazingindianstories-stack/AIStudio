from django.db import models

class Project(models.Model):
    id = models.UUIDField(primary_key=True)
    name = models.TextField()
    brief = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'projects'
