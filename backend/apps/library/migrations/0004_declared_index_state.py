from django.db import migrations, models
from django.db.models.expressions import RawSQL
from apps.common.indexes import PostgreSQLIndex, PostgreSQLUniqueIndex


class Migration(migrations.Migration):
    dependencies = [('library', '0003_current_relationships')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddIndex(model_name='folder', index=PostgreSQLIndex(models.F('project').asc(nulls_last=True), name='folders_project_id_idx')),
                migrations.AddIndex(model_name='folder', index=PostgreSQLIndex(models.F('parent').asc(nulls_last=True), name='folders_parent_id_idx')),
                migrations.AddIndex(model_name='folder', index=PostgreSQLUniqueIndex(models.F('name_normalized').asc(nulls_last=True), name='folders_global_root_unique_idx', condition=models.Q(RawSQL('"parent_id" is null and "project_id" is null', [], output_field=models.BooleanField())))),
                migrations.AddIndex(model_name='folder', index=PostgreSQLUniqueIndex(models.F('project').asc(nulls_last=True), models.F('name_normalized').asc(nulls_last=True), name='folders_project_root_unique_idx', condition=models.Q(RawSQL('"parent_id" is null and "project_id" is not null', [], output_field=models.BooleanField())))),
                migrations.AddIndex(model_name='folder', index=PostgreSQLUniqueIndex(models.F('parent').asc(nulls_last=True), models.F('name_normalized').asc(nulls_last=True), name='folders_subfolder_unique_idx', condition=models.Q(RawSQL('"parent_id" is not null', [], output_field=models.BooleanField())))),
                migrations.AddIndex(model_name='organizationidempotencykey', index=PostgreSQLIndex(models.F('created_at').asc(nulls_last=True), name='organization_idempotency_keys_created_idx')),
                migrations.AddIndex(model_name='organizationidempotencykey', index=PostgreSQLIndex(models.F('expires_at').asc(nulls_last=True), name='organization_idempotency_keys_expires_idx')),
                migrations.AddIndex(model_name='organizationidempotencykey', index=PostgreSQLIndex(models.F('actor_id').asc(nulls_last=True), models.F('operation').asc(nulls_last=True), name='organization_idempotency_keys_actor_op_idx')),
                migrations.AddIndex(model_name='generationnaming', index=PostgreSQLUniqueIndex(models.F('namespace').asc(nulls_last=True), models.F('sequence').asc(nulls_last=True), name='generation_naming_namespace_seq_idx')),
                migrations.AddIndex(model_name='generationnaming', index=PostgreSQLIndex(models.F('namespace').asc(nulls_last=True), name='generation_naming_namespace_idx')),
            ],
        ),
    ]
