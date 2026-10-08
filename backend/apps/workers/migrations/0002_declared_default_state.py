from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('workers', '0001_initial')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='depthworker', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='depthworker', name='status', field=models.TextField(default="idle", db_default='idle')),
                migrations.AlterField(model_name='depthworker', name='protocol_version', field=models.IntegerField(default=1, db_default=1)),
            ],
        ),
    ]
