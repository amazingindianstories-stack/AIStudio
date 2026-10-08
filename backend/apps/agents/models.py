from django.db import models


class AgentConversation(models.Model):
    id = models.UUIDField(primary_key=True)
    project_id = models.UUIDField()
    name = models.TextField()
    kind = models.TextField(default='chat')
    agent_kind = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'agent_conversations'


class AgentConversationMessage(models.Model):
    id = models.UUIDField(primary_key=True)
    # Drizzle currently declares a UUID column without a foreign key.
    conversation_id = models.UUIDField()
    role = models.TextField()
    content = models.TextField()
    tool_trace = models.JSONField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = False
        db_table = 'agent_conversation_messages'
