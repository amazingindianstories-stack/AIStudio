from django.db import migrations, models
from django.contrib.postgres.functions import RandomUUID


class Migration(migrations.Migration):
    dependencies = [('agents', '0002_declared_index_state')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterField(model_name='agentconversation', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
                migrations.AlterField(model_name='agentconversation', name='kind', field=models.TextField(default='chat', db_default='chat')),
                migrations.AlterField(model_name='agentconversationmessage', name='id', field=models.UUIDField(primary_key=True, db_default=RandomUUID())),
            ],
        ),
    ]
