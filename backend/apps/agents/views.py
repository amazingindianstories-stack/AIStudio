import logging
import math
import os
import uuid
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.responses import renew_session
from apps.generation.watermark import WHITESPACE
from apps.library.views import body_or_empty
from . import media, services
from .images import parse_message_body, images_to_parts
from .loop_llm import VOICE_MIME, UsageContext
from .models import AgentConversation
from .orchestrator import run_turn

logger = logging.getLogger(__name__)


def admin(request):
    user = lookup(request)
    return user if user and user.role == 'admin' else None


def forbidden():
    return Response({'error': 'FORBIDDEN'}, status=403)


def first(request, key):
    values = request.query_params.getlist(key)
    return values[0] if values else None


def name_value(value):
    return (value or '').strip(WHITESPACE)


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def conversations(request):
    user = admin(request)
    if user is None:
        return forbidden()
    if request.method == 'GET':
        project, kind = first(request, 'projectId'), first(request, 'agentKind')
        if not project:
            return Response({'error': 'projectId required.'}, status=400)
        if kind not in ('image', 'video'):
            return Response({'error': "agentKind must be 'image' or 'video'."}, status=400)
        return renew_session(request, Response({'conversations': services.list_conversations(project, kind)}))
    body = body_or_empty(request)
    operation = body.get('op')
    if operation == 'createConversation':
        name, project, kind = name_value(body.get('name')), body.get('projectId'), body.get('agentKind')
        if not project:
            return Response({'error': 'projectId required.'}, status=400)
        if kind not in ('image', 'video'):
            return Response({'error': "agentKind must be 'image' or 'video'."}, status=400)
        if not name:
            return Response({'error': 'Name required.'}, status=400)
        conversation = services.create_conversation(project, kind, name, user.id)
        return renew_session(request, Response({'conversations': services.list_conversations(project, kind), 'conversation': conversation}))
    if operation in ('renameConversation', 'deleteConversation'):
        if not body.get('id'):
            return Response({'error': 'id required.'}, status=400)
        existing = services.get_conversation(body['id'])
        if not existing:
            return Response({'error': 'Conversation not found.'}, status=404)
        if operation == 'renameConversation':
            services.rename_conversation(body['id'], name_value(body.get('name')))
        else:
            services.delete_conversation(body['id'])
        return renew_session(request, Response({'conversations': services.list_conversations(existing['projectId'], existing['agentKind'])}))
    return Response({'error': 'Unknown op.'}, status=400)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def detail(request, id):
    if admin(request) is None:
        return forbidden()
    conversation = services.get_conversation(id)
    if not conversation:
        return Response({'error': 'Conversation not found.'}, status=404)
    return renew_session(request, Response({'conversation': conversation, 'messages': services.list_messages(id)}))


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def messages(request, id):
    if admin(request) is None:
        return forbidden()
    conversation = services.get_conversation(id)
    if not conversation:
        return Response({'error': 'Conversation not found.'}, status=404)
    parsed = parse_message_body(body_or_empty(request))
    if 'error' in parsed:
        return Response(parsed, status=400)
    try:
        parts = images_to_parts(parsed['images'])
    except Exception:
        return Response({'error': 'Invalid reference image.'}, status=400)
    history = [{'role': row['role'], 'content': row['content']} for row in services.list_messages(id)]
    user_message = services.append_message(id, 'user', parsed['content'])
    try:
        result = run_turn(history, parsed['content'], parts, conversation['agentKind'])
        assistant = services.append_message(id, 'assistant', result['reply'], result.get('toolTrace'))
        return renew_session(request, Response({'userMessage': user_message, 'assistantMessage': assistant}))
    except Exception as error:
        logger.warning('agent_turn_failed conversation_id=%s error_type=%s', id, type(error).__name__)
        return renew_session(request, Response({'userMessage': user_message, 'error': 'Orchestrator request failed.'}, status=502))


@api_view(['PATCH'])
@authentication_classes([])
@permission_classes([])
def attach(request, id, message_id):
    if admin(request) is None:
        return forbidden()
    if not services.get_conversation(id):
        return Response({'error': 'Conversation not found.'}, status=404)
    body = body_or_empty(request)
    generated = body.get('generatedItemId').strip(WHITESPACE) if isinstance(body.get('generatedItemId'), str) else ''
    if not generated:
        return Response({'error': 'generatedItemId is required.'}, status=400)
    message = services.attach_generated_item(id, message_id, generated)
    if not message:
        return Response({'error': 'Message not found.'}, status=404)
    return renew_session(request, Response({'message': message}))


def owned(id, user_id):
    try:
        return AgentConversation.objects.filter(pk=uuid.UUID(id), user_id=user_id).exists()
    except ValueError:
        return False


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def transcribe(request, id):
    """GET: the voice note caps. POST: the raw recording (its own Content-Type, ``durationMs`` in the query) as
    ``{transcript}``; raw bytes keep a 4 MB note under Vercel's 4.5 MB request body, which base64 would not. The audio
    goes to Gemini only: no upload session, no storage write, and neither it nor the transcript is logged."""
    user = admin(request)
    if user is None:
        return forbidden()
    if not owned(id, user.id):
        return Response({'error': 'Conversation not found.'}, status=404)
    max_seconds, max_bytes = media.limit(user.id, 'agentVoiceMaxSeconds'), media.limit(user.id, 'agentVoiceMaxBytes')
    if request.method == 'GET':
        return renew_session(request, Response({'maxSeconds': max_seconds, 'maxBytes': max_bytes}))
    mime = media.normalize(request.headers.get('Content-Type'))
    if mime not in VOICE_MIME:
        return Response({'error': 'Send the voice note as WebM, MP4, Ogg, MP3 or WAV audio.'}, status=415)
    try:
        seconds = float(first(request, 'durationMs')) / 1000
    except (TypeError, ValueError):
        seconds = math.nan
    if not 0 < seconds <= max_seconds:
        return Response({'error': f'A voice note can be up to {max_seconds} seconds long.'}, status=413 if seconds > max_seconds else 400)
    try:
        declared = int(request.META.get('CONTENT_LENGTH') or 0)
    except ValueError:
        return Response({'error': 'Invalid Content-Length.'}, status=400)
    audio = request.read(max_bytes + 1) if declared <= max_bytes else b''
    if declared > max_bytes or len(audio) > max_bytes:
        return Response({'error': f'A voice note can be up to {max_bytes / media.MB:g} MB.'}, status=413)
    if not audio:
        return Response({'error': 'The voice note is empty.'}, status=400)
    if len(audio) > media.VOICE_SLACK + seconds * media.VOICE_BYTE_RATE:
        return Response({'error': 'The voice note is longer than its reported duration.'}, status=400)
    key = os.environ.get('GOOGLE_API_KEY')
    if not key:
        return Response({'error': 'Voice input is not configured: GOOGLE_API_KEY is not set. Ask a Veevee admin.'}, status=503)
    usage = UsageContext(user_id=user.id, conversation_id=uuid.UUID(id), purpose='transcribe')
    transcript = media.transcribe(mime, audio, api_key=key, usage=usage)
    if transcript is None:
        return renew_session(request, Response({'error': 'Veevee could not transcribe the voice note. Try again.'}, status=502))
    return renew_session(request, Response({'transcript': transcript}))
