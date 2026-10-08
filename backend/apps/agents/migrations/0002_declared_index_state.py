from django.db import migrations, models
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('agents', '0001_initial')]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AddIndex(model_name='agentconversation', index=PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), name='agent_conversations_project_id_idx')),
                migrations.AddIndex(model_name='agentconversation', index=PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), models.F('agent_kind').asc(nulls_last=True), name='agent_conversations_project_kind_idx')),
                migrations.AddIndex(model_name='agentconversationmessage', index=PostgreSQLIndex(models.F('conversation_id').asc(nulls_last=True), name='agent_conversation_messages_conversation_id_idx')),
            ],
        ),
    ]
