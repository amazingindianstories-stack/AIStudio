"""Port of src/lib/agent-conversations-db.js — orchestrator chat-thread
persistence."""

import time
import uuid

from .models import AgentConversation, AgentConversationMessage


def _row_to_meta(c: AgentConversation) -> dict:
    return {
        "id": str(c.id),
        "projectId": str(c.project_id),
        "name": c.name,
        # Defensive fallback for rows written before this column existed.
        "agentKind": c.agent_kind if c.agent_kind == "video" else "image",
        "createdBy": str(c.created_by) if c.created_by else None,
        "createdAt": c.created_at,
        "updatedAt": c.updated_at,
    }


def _row_to_message(m: AgentConversationMessage) -> dict:
    return {
        "id": str(m.id),
        "conversationId": str(m.conversation_id),
        "role": m.role if m.role == "assistant" else "user",
        "content": m.content,
        "toolTrace": m.tool_trace,
        "createdAt": m.created_at,
    }


def list_conversations(project_id: str, agent_kind: str) -> list[dict]:
    return [_row_to_meta(c) for c in AgentConversation.objects.filter(project_id=project_id, agent_kind=agent_kind)]


def get_conversation(conversation_id: str) -> dict | None:
    c = AgentConversation.objects.filter(id=conversation_id).first()
    return _row_to_meta(c) if c else None


def create_conversation(project_id: str, agent_kind: str, name: str, created_by: str | None) -> dict:
    now = int(time.time() * 1000)
    c = AgentConversation.objects.create(
        id=uuid.uuid4(), project_id=project_id, agent_kind=agent_kind, name=name,
        created_by=created_by, created_at=now, updated_at=now,
    )
    return _row_to_meta(c)


def rename_conversation(conversation_id: str, name: str) -> None:
    AgentConversation.objects.filter(id=conversation_id).update(name=name, updated_at=int(time.time() * 1000))


def delete_conversation(conversation_id: str) -> None:
    AgentConversation.objects.filter(id=conversation_id).delete()
    AgentConversationMessage.objects.filter(conversation_id=conversation_id).delete()


def list_messages(conversation_id: str) -> list[dict]:
    return [
        _row_to_message(m)
        for m in AgentConversationMessage.objects.filter(conversation_id=conversation_id).order_by("created_at")
    ]


def attach_generated_item(message_id: str, item_id: str) -> dict | None:
    """Attaches the id of the GenerationItem a message's tool call
    actually produced. No-op (returns None) if the message has no
    toolTrace to attach onto."""
    existing = AgentConversationMessage.objects.filter(id=message_id).first()
    if not existing or not existing.tool_trace:
        return None
    tool_trace = {**existing.tool_trace, "generatedItemId": item_id}
    AgentConversationMessage.objects.filter(id=message_id).update(tool_trace=tool_trace)
    existing.refresh_from_db()
    return _row_to_message(existing)


def append_message(conversation_id: str, role: str, content: str, tool_trace: dict | None = None) -> dict:
    now = int(time.time() * 1000)
    m = AgentConversationMessage.objects.create(
        id=uuid.uuid4(), conversation_id=conversation_id, role=role, content=content,
        tool_trace=tool_trace, created_at=now,
    )
    AgentConversation.objects.filter(id=conversation_id).update(updated_at=now)
    return _row_to_message(m)
