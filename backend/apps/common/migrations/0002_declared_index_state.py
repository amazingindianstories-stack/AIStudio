from django.db import migrations, models
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('common', '0001_initial')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddIndex(model_name='activitylog', index=PostgreSQLIndex(models.F('created_at').asc(nulls_last=True), name='activity_logs_created_at_idx')),
            ],
        ),
    ]
