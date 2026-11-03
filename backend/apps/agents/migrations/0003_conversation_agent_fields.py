"""Additive Gemini agent fields on agent_conversations: nullable columns, settings defaulting to '{}', and user_id
backfilled from created_by. Old images keep inserting without them; user_id becomes NOT NULL in a later contract."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('agents', '0002_railway_v2_agentconversationmessage')]
    operations = [
        migrations.AddField(model_name='agentconversation', name='user_id', field=models.UUIDField(null=True)),
        migrations.AddField(model_name='agentconversation', name='default_project_id', field=models.UUIDField(null=True)),
        migrations.AddField(model_name='agentconversation', name='default_folder_id', field=models.UUIDField(null=True)),
        migrations.AddField(model_name='agentconversation', name='settings', field=models.JSONField(db_default={}, default=dict)),
        migrations.AddField(model_name='agentconversation', name='status', field=models.TextField(null=True)),
        migrations.AddField(model_name='agentconversation', name='summary', field=models.TextField(null=True)),
        migrations.AddField(model_name='agentconversation', name='last_run_at', field=models.BigIntegerField(null=True)),
        migrations.RunSQL('UPDATE agent_conversations SET user_id = created_by WHERE user_id IS NULL AND created_by IS NOT NULL',
                          migrations.RunSQL.noop),
    ]
