from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('generation', '0004_keyset_null_order_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='generation', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='generation', name='cost_cents', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='generation', name='cost_basis', field=models.TextField(default="estimated", db_default='estimated')),
                migrations.AlterField(model_name='generation', name='is_favorite', field=models.BooleanField(default=False, db_default=False)),
                migrations.AlterField(model_name='generation', name='poll_attempts', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='generation', name='poll_error_count', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='generation', name='depth_reap_attempts', field=models.IntegerField(default=0, db_default=0)),
                migrations.AlterField(model_name='generation', name='flagged', field=models.BooleanField(default=False, db_default=False)),
                migrations.AlterField(model_name='generation', name='location_version', field=models.IntegerField(default=1, db_default=1)),
            ],
        ),
    ]
