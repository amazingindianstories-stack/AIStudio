"""Conversation persistence with explicit transactions for no-FK message rows."""
from django.db import transaction
from apps.library.services.idempotency import now_ms
from .models import AgentConversation, AgentConversationMessage


def conversation_json(row):
    return {'id': str(row.id), 'projectId': str(row.project_id), 'name': row.name,
        'agentKind': 'video' if row.agent_kind == 'video' else 'image',
        'createdBy': str(row.created_by) if row.created_by else None,
        'createdAt': row.created_at, 'updatedAt': row.updated_at}


def message_json(row):
    return {'id': str(row.id), 'conversationId': str(row.conversation_id),
        'role': 'assistant' if row.role == 'assistant' else 'user', 'content': row.content,
        'toolTrace': row.tool_trace, 'createdAt': row.created_at}


def list_conversations(project_id, kind):
    return [conversation_json(row) for row in AgentConversation.objects.filter(project_id=project_id, agent_kind=kind).order_by('-updated_at')]


def get_conversation(identifier):
    row = AgentConversation.objects.filter(pk=identifier).first()
    return conversation_json(row) if row else None


def create_conversation(project_id, kind, name, created_by):
    now = now_ms()
    row = AgentConversation.objects.create(project_id=project_id, agent_kind=kind, name=name,
        created_by=created_by, created_at=now, updated_at=now)
    return conversation_json(row)


def rename_conversation(identifier, name):
    AgentConversation.objects.filter(pk=identifier).update(name=name, updated_at=now_ms())


@transaction.atomic
def delete_conversation(identifier):
    row = AgentConversation.objects.select_for_update().filter(pk=identifier).first()
    if row:
        AgentConversationMessage.objects.filter(conversation_id=identifier).delete()
        row.delete()


def list_messages(identifier):
    return [message_json(row) for row in AgentConversationMessage.objects.filter(conversation_id=identifier).order_by('created_at')]


@transaction.atomic
def append_message(identifier, role, content, tool_trace=None):
    conversation = AgentConversation.objects.select_for_update().filter(pk=identifier).first()
    if conversation is None:
        raise ValueError('Conversation not found.')
    now = now_ms()
    row = AgentConversationMessage.objects.create(conversation_id=identifier, role=role,
        content=content, tool_trace=tool_trace, created_at=now)
    conversation.updated_at = now
    conversation.save(update_fields=['updated_at'])
    return message_json(row)


@transaction.atomic
def attach_generated_item(conversation_id, message_id, item_id):
    # Scope the message to the requested thread, closing the legacy URL mismatch.
    row = AgentConversationMessage.objects.select_for_update().filter(pk=message_id, conversation_id=conversation_id).first()
    if row is None or row.tool_trace is None:
        return None
    trace = row.tool_trace if isinstance(row.tool_trace, dict) else {}
    row.tool_trace = {**trace, 'generatedItemId': item_id}
    row.save(update_fields=['tool_trace'])
    return message_json(row)
