from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('authentication', '0005_declared_index_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='user', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='user', name='role', field=models.TextField(db_default='user')),
                migrations.AlterField(model_name='user', name='is_active', field=models.BooleanField(db_default=True)),
                migrations.AlterField(model_name='user', name='auth_version', field=models.IntegerField(db_default=0)),
                migrations.AlterField(model_name='loginattempt', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
            ],
        ),
    ]
