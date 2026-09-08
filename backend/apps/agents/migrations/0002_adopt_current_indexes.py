from django.db import migrations, models
import apps.common.indexes


class Migration(migrations.Migration):
    dependencies = [("agents", "0001_initial")]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.AlterModelOptions(name="agentconversation", options={"db_table": "agent_conversations"}),
                migrations.AlterModelOptions(name="agentconversationmessage", options={"db_table": "agent_conversation_messages"}),
                migrations.AddIndex(model_name="agentconversation", index=apps.common.indexes.PostgresIndex(fields=["project_id"], name="agent_conversations_project_id_idx")),
                migrations.AddIndex(model_name="agentconversation", index=apps.common.indexes.PostgresIndex(fields=["project_id", "agent_kind"], name="agent_conversations_project_kind_idx")),
                migrations.AddIndex(model_name="agentconversationmessage", index=apps.common.indexes.PostgresIndex(fields=["conversation_id"], name="agent_conversation_messages_conversation_id_idx")),
            ],
        )
    ]
