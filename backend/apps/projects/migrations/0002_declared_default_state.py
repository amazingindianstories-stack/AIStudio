from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('projects', '0001_initial')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='project', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
            ],
        ),
    ]
