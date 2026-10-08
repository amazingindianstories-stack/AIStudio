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
    # Physical FK/CASCADE is currently owned by Drizzle/migration SQL. The
    # generation model/relation and physical baseline remain a separate gate.
    generation_id = models.UUIDField(primary_key=True)
    namespace = models.TextField()
    sequence = models.BigIntegerField()
    assigned_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'generation_naming'
