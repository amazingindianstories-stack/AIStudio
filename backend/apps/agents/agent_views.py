"""Port of src/app/api/{agent-conversations/*,agents/{image,video,story}}
route.js files."""

from rest_framework.decorators import api_view
from rest_framework.response import Response

from . import agent_conversations_db as db
from .agents import legacy
from .agents.orchestrator.images import images_to_parts
from .agents.orchestrator.orchestrator import run_orchestrator_turn
from .agents.orchestrator.validate_message import parse_message_body


def _parse_agent_kind(value) -> str | None:
    return value if value in ("image", "video") else None


def _sort_for_switcher(items: list[dict]) -> list[dict]:
    return sorted(items, key=lambda x: x["updatedAt"], reverse=True)


@api_view(["GET", "POST"])
def agent_conversations(request):
    if request.method == "GET":
        project_id = request.query_params.get("projectId")
        agent_kind = _parse_agent_kind(request.query_params.get("agentKind"))
        if not project_id:
            return Response({"error": "projectId required."}, status=400)
        if not agent_kind:
            return Response({"error": "agentKind must be 'image' or 'video'."}, status=400)
        return Response({"conversations": _sort_for_switcher(db.list_conversations(project_id, agent_kind))})

    body = request.data or {}
    op = body.get("op")

    if op == "createConversation":
        name = (body.get("name") or "").strip()
        project_id = body.get("projectId")
        agent_kind = _parse_agent_kind(body.get("agentKind"))
        if not project_id:
            return Response({"error": "projectId required."}, status=400)
        if not agent_kind:
            return Response({"error": "agentKind must be 'image' or 'video'."}, status=400)
        if not name:
            return Response({"error": "Name required."}, status=400)
        conversation = db.create_conversation(project_id, agent_kind, name, str(request.user.id))
        return Response({
            "conversations": _sort_for_switcher(db.list_conversations(project_id, agent_kind)),
            "conversation": conversation,
        })

    if op == "renameConversation":
        if not body.get("id"):
            return Response({"error": "id required."}, status=400)
        existing = db.get_conversation(body["id"])
        if not existing:
            return Response({"error": "Conversation not found."}, status=404)
        db.rename_conversation(body["id"], (body.get("name") or "").strip())
        return Response({"conversations": _sort_for_switcher(db.list_conversations(existing["projectId"], existing["agentKind"]))})

    if op == "deleteConversation":
        if not body.get("id"):
            return Response({"error": "id required."}, status=400)
        existing = db.get_conversation(body["id"])
        if not existing:
            return Response({"error": "Conversation not found."}, status=404)
        db.delete_conversation(body["id"])
        return Response({"conversations": _sort_for_switcher(db.list_conversations(existing["projectId"], existing["agentKind"]))})

    return Response({"error": "Unknown op."}, status=400)


@api_view(["GET"])
def agent_conversation_detail(request, conversation_id):
    conversation = db.get_conversation(conversation_id)
    if not conversation:
        return Response({"error": "Conversation not found."}, status=404)
    return Response({"conversation": conversation, "messages": db.list_messages(conversation_id)})


@api_view(["POST"])
def agent_conversation_messages(request, conversation_id):
    conversation = db.get_conversation(conversation_id)
    if not conversation:
        return Response({"error": "Conversation not found."}, status=404)

    parsed = parse_message_body(request.data or {})
    if "error" in parsed:
        return Response({"error": parsed["error"]}, status=400)
    content, image_data_urls = parsed["content"], parsed["images"]

    try:
        image_parts = images_to_parts(image_data_urls)
    except Exception as e:
        return Response({"error": str(e) or "Invalid reference image."}, status=400)

    prior_messages = db.list_messages(conversation_id)
    history = [{"role": m["role"], "content": m["content"]} for m in prior_messages]

    user_message = db.append_message(conversation_id, "user", content)

    try:
        result = run_orchestrator_turn(history, content, image_parts, conversation["agentKind"])
        assistant_message = db.append_message(conversation_id, "assistant", result["reply"], result.get("toolTrace"))
        return Response({"userMessage": user_message, "assistantMessage": assistant_message})
    except Exception as e:
        return Response({"userMessage": user_message, "error": str(e) or "Orchestrator request failed."}, status=502)


@api_view(["PATCH"])
def agent_conversation_message_detail(request, conversation_id, message_id):
    conversation = db.get_conversation(conversation_id)
    if not conversation:
        return Response({"error": "Conversation not found."}, status=404)

    body = request.data or {}
    generated_item_id = body.get("generatedItemId").strip() if isinstance(body.get("generatedItemId"), str) else ""
    if not generated_item_id:
        return Response({"error": "generatedItemId is required."}, status=400)

    message = db.attach_generated_item(message_id, generated_item_id)
    if not message:
        return Response({"error": "Message not found."}, status=404)
    return Response({"message": message})


def _handle_agent_request(role: str, request):
    """Port of route-handler.js's handleAgentRequest — shared body of the
    (unreachable from the UI) /api/agents/{image,video,story} routes."""
    messages = legacy.parse_messages((request.data or {}).get("messages"))
    if not messages:
        return Response({"error": "messages must be a non-empty array of { role, content }."}, status=400)
    context = (request.data or {}).get("context")
    context = context if isinstance(context, dict) else None

    try:
        result = legacy.run_chat_agent(role, messages, context)
        return Response(result)
    except Exception as e:
        return Response({"error": str(e) or "Agent request failed."}, status=502)


@api_view(["POST"])
def agent_image(request):
    return _handle_agent_request("image", request)


@api_view(["POST"])
def agent_video(request):
    return _handle_agent_request("video", request)


@api_view(["POST"])
def agent_story(request):
    return _handle_agent_request("story", request)
