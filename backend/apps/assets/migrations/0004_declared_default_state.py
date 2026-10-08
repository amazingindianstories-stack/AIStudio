from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('assets', '0003_declared_index_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='asset', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='asset', name='images', field=models.JSONField(db_default=[])),
                migrations.AlterField(model_name='portraitgroup', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='portraitgroup', name='group_type', field=models.TextField(default='AIGC', db_default='AIGC')),
                migrations.AlterField(model_name='portraitgroup', name='project_name', field=models.TextField(default='default', db_default='default')),
                migrations.AlterField(model_name='portraitasset', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='portraitasset', name='asset_type', field=models.TextField(default='Image', db_default='Image')),
                migrations.AlterField(model_name='portraitasset', name='role', field=models.TextField(default='reference', db_default='reference')),
                migrations.AlterField(model_name='portraitasset', name='status', field=models.TextField(default='Processing', db_default='Processing')),
            ],
        ),
    ]
