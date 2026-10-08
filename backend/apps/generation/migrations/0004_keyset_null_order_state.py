from django.db import migrations, models
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('generation', '0003_worker_index_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RemoveIndex(model_name='generation', name='generations_created_keyset_idx'),
                migrations.AddIndex(model_name='generation', index=PostgreSQLIndex(models.F('created_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_created_keyset_idx')),
                migrations.RemoveIndex(model_name='generation', name='generations_project_keyset_idx'),
                migrations.AddIndex(model_name='generation', index=PostgreSQLIndex(models.F('project').asc(nulls_last=True), models.F('created_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_project_keyset_idx')),
                migrations.RemoveIndex(model_name='generation', name='generations_folder_keyset_idx'),
                migrations.AddIndex(model_name='generation', index=PostgreSQLIndex(models.F('folder').asc(nulls_last=True), models.F('created_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_folder_keyset_idx')),
                migrations.RemoveIndex(model_name='generation', name='generations_favorite_keyset_idx'),
                migrations.AddIndex(model_name='generation', index=PostgreSQLIndex(models.F('favorited_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_favorite_keyset_idx', condition=models.Q(is_favorite=True))),
                migrations.RemoveIndex(model_name='generation', name='generations_flagged_keyset_idx'),
                migrations.AddIndex(model_name='generation', index=PostgreSQLIndex(models.F('flagged_at').desc(nulls_last=True), models.F('id').desc(nulls_last=True), name='generations_flagged_keyset_idx', condition=models.Q(flagged=True))),
            ],
        ),
    ]
