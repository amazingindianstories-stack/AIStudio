from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('canvas', '0002_declared_index_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='canvasboard', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
            ],
        ),
    ]
