from django.urls import path

from . import agent_views

urlpatterns = [
    path("agent-conversations", agent_views.agent_conversations, name="agent-conversations"),
    path("agent-conversations/<str:conversation_id>", agent_views.agent_conversation_detail, name="agent-conversation-detail"),
    path("agent-conversations/<str:conversation_id>/messages", agent_views.agent_conversation_messages, name="agent-conversation-messages"),
    path(
        "agent-conversations/<str:conversation_id>/messages/<str:message_id>",
        agent_views.agent_conversation_message_detail,
        name="agent-conversation-message-detail",
    ),
]
