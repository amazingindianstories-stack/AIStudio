from django.contrib.postgres.functions import RandomUUID
from apps.common.indexes import PostgreSQLIndex
from django.db import models


class AgentConversation(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    project_id = models.UUIDField()
    name = models.TextField()
    kind = models.TextField(default='chat', db_default='chat')
    agent_kind = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_conversations'
        indexes = [
            PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), name='agent_conversations_project_id_idx'),
            PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), models.F('agent_kind').asc(nulls_last=True), name='agent_conversations_project_kind_idx'),
        ]


class AgentConversationMessage(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    # Drizzle currently declares a UUID column without a foreign key.
    conversation_id = models.UUIDField()
    role = models.TextField()
    content = models.TextField()
    tool_trace = models.JSONField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_conversation_messages'
        indexes = [
            PostgreSQLIndex(models.F('conversation_id').asc(nulls_last=True), name='agent_conversation_messages_conversation_id_idx'),
        ]
