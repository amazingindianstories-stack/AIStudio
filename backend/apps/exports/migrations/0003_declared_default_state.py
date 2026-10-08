from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('exports', '0002_declared_index_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='mediaexport', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='mediaexport', name='status', field=models.TextField(default="draft", db_default='draft')),
                migrations.AlterField(model_name='mediaexport', name='total_items', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='mediaexport', name='processed_items', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='mediaexport', name='skipped_items', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='mediaexport', name='warnings', field=models.JSONField(default=list, db_default=[])),
                migrations.AlterField(model_name='mediaexport', name='attempt_count', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='mediaexport', name='manifest_version', field=models.IntegerField(default=1, db_default=1)),
            ],
        ),
    ]
