from django.db import models

class Folder(models.Model):
    id = models.UUIDField(primary_key=True)
    project = models.ForeignKey('projects.Project', on_delete=models.RESTRICT, db_column='project_id', null=True)
    parent = models.ForeignKey('self', on_delete=models.RESTRICT, db_column='parent_id', null=True)
    name = models.TextField()
    name_normalized = models.TextField()
    version = models.IntegerField()
    color = models.TextField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    class Meta:
        managed = False
        db_table = 'folders'


class OrganizationIdempotencyKey(models.Model):
    key = models.TextField(primary_key=True)
    actor_id = models.TextField(null=True)
    operation = models.TextField()
    fingerprint = models.TextField()
    status = models.TextField(default='completed')
    result = models.JSONField(null=True)
    created_at = models.BigIntegerField()
    expires_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'organization_idempotency_keys'


class NamingCounter(models.Model):
    namespace = models.TextField(primary_key=True)
    next_sequence = models.BigIntegerField(default=1)
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'naming_counters'


class GenerationNaming(models.Model):
    generation = models.OneToOneField('generation.Generation', on_delete=models.CASCADE, db_column='generation_id', primary_key=True)
    namespace = models.TextField()
    sequence = models.BigIntegerField()
    assigned_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'generation_naming'
