"""Mirrors src/lib/schema.js `agent_conversations`/`agent_conversation_messages`.
managed = TEST_MANAGED — see apps/common/db_flags.py and the backend/
section of CLAUDE.md."""

import uuid

from django.db import models

from apps.common.db_flags import TEST_MANAGED


class AgentConversation(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    project_id = models.UUIDField()
    name = models.TextField()
    kind = models.TextField(default="chat")
    agent_kind = models.TextField(null=True)  # "image" | "video"
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "agent_conversations"


class AgentConversationMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    conversation_id = models.UUIDField()
    role = models.TextField()  # "user" | "assistant"
    content = models.TextField()
    tool_trace = models.JSONField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = TEST_MANAGED
        db_table = "agent_conversation_messages"
