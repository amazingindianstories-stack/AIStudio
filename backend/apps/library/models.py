from django.contrib.postgres.functions import RandomUUID
from apps.common.indexes import PostgreSQLIndex, PostgreSQLUniqueIndex
from django.db.models.expressions import RawSQL
from django.db import models

class Folder(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    project = models.ForeignKey('projects.Project', on_delete=models.RESTRICT, db_column='project_id', null=True)
    parent = models.ForeignKey('self', on_delete=models.RESTRICT, db_column='parent_id', null=True)
    name = models.TextField()
    name_normalized = models.TextField(db_default='')
    version = models.IntegerField(db_default=1)
    color = models.TextField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField(db_default=0)
    class Meta:
        managed = False
        db_table = 'folders'
        constraints = [models.CheckConstraint(name='folders_color_check', condition=models.Q(color__isnull=True) | models.Q(color__in=['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']))]
        indexes = [
            PostgreSQLIndex(models.F('project').asc(nulls_last=True), name='folders_project_id_idx'),
            PostgreSQLIndex(models.F('parent').asc(nulls_last=True), name='folders_parent_id_idx'),
            PostgreSQLUniqueIndex(models.F('name_normalized').asc(nulls_last=True), name='folders_global_root_unique_idx', condition=models.Q(RawSQL('"parent_id" is null and "project_id" is null', [], output_field=models.BooleanField()))),
            PostgreSQLUniqueIndex(models.F('project').asc(nulls_last=True), models.F('name_normalized').asc(nulls_last=True), name='folders_project_root_unique_idx', condition=models.Q(RawSQL('"parent_id" is null and "project_id" is not null', [], output_field=models.BooleanField()))),
            PostgreSQLUniqueIndex(models.F('parent').asc(nulls_last=True), models.F('name_normalized').asc(nulls_last=True), name='folders_subfolder_unique_idx', condition=models.Q(RawSQL('"parent_id" is not null', [], output_field=models.BooleanField()))),
        ]


class OrganizationIdempotencyKey(models.Model):
    key = models.TextField(primary_key=True)
    actor_id = models.TextField(null=True)
    operation = models.TextField()
    fingerprint = models.TextField()
    status = models.TextField(default='completed', db_default='completed')
    result = models.JSONField(null=True)
    created_at = models.BigIntegerField()
    expires_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'organization_idempotency_keys'
        indexes = [
            PostgreSQLIndex(models.F('created_at').asc(nulls_last=True), name='organization_idempotency_keys_created_idx'),
            PostgreSQLIndex(models.F('expires_at').asc(nulls_last=True), name='organization_idempotency_keys_expires_idx'),
            PostgreSQLIndex(models.F('actor_id').asc(nulls_last=True), models.F('operation').asc(nulls_last=True), name='organization_idempotency_keys_actor_op_idx'),
        ]


class NamingCounter(models.Model):
    namespace = models.TextField(primary_key=True)
    next_sequence = models.BigIntegerField(default=1, db_default=1)
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
        constraints = [models.CheckConstraint(name='generation_naming_sequence_check', condition=models.Q(sequence__gt=0))]
        indexes = [
            PostgreSQLUniqueIndex(models.F('namespace').asc(nulls_last=True), models.F('sequence').asc(nulls_last=True), name='generation_naming_namespace_seq_idx'),
            PostgreSQLIndex(models.F('namespace').asc(nulls_last=True), name='generation_naming_namespace_idx'),
        ]
