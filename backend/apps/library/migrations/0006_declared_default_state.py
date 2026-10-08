from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('library', '0005_current_check_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='folder', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='folder', name='name_normalized', field=models.TextField(db_default='')),
                migrations.AlterField(model_name='folder', name='version', field=models.IntegerField(db_default=1)),
                migrations.AlterField(model_name='folder', name='updated_at', field=models.BigIntegerField(db_default=0)),
                migrations.AlterField(model_name='organizationidempotencykey', name='status', field=models.TextField(default='completed', db_default='completed')),
                migrations.AlterField(model_name='namingcounter', name='next_sequence', field=models.BigIntegerField(default=1, db_default=1)),
            ],
        ),
    ]
