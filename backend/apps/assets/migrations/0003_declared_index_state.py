from django.db import migrations, models
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('assets', '0002_portraitasset_portraitgroup')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddIndex(model_name='portraitgroup', index=models.Index(fields=['project_id'], name='portrait_groups_project_id_idx')),
                migrations.AddIndex(model_name='asset', index=PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), name='assets_project_id_idx')),
            ],
        ),
    ]
