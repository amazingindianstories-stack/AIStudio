"""A database foreign key from agent_conversation_messages to agent_conversations, ON DELETE CASCADE.

Messages whose conversation is gone are deleted first. The constraint is added NOT VALID, so adding it takes no
full-table scan under lock; new and updated rows are checked from now on. A later contract migration validates it."""
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [('agents', '0003_conversation_agent_fields')]
    operations = [
        migrations.RunSQL(
            ['DELETE FROM agent_conversation_messages m WHERE NOT EXISTS '
             '(SELECT 1 FROM agent_conversations c WHERE c.id = m.conversation_id)',
             'ALTER TABLE agent_conversation_messages ADD CONSTRAINT agent_conversation_messages_conversation_id_fkey '
             'FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE NOT VALID'],
            ['ALTER TABLE agent_conversation_messages DROP CONSTRAINT agent_conversation_messages_conversation_id_fkey']),
    ]
