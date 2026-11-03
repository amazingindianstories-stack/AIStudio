import logging
import math
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from django.db import connections
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.responses import renew_session
from apps.generation.watermark import WHITESPACE
from apps.library.views import body_or_empty
from apps.mcp import errors
from . import media, services
from .images import parse_message_body, images_to_parts
from .loop_llm import VOICE_MIME, UsageContext
from .models import AgentConversation
from .orchestrator import run_turn

logger = logging.getLogger(__name__)

MAX_ATTACHMENTS = 10                    # the composer's MAX_DOCUMENTS (src/lib/agent-attachments.js)
ATTACHMENT_ID_CHARS = 64
MAX_PDFS = 3                            # PDFs of one message, all described at once
REQUEST_SECONDS = 100                   # one message's PDF describes and chat turn, well inside the gateway's 120 s wait
DOCUMENT_SECONDS = 60                   # of which the PDF describes take at most this
TURN_RESERVE_SECONDS = 40               # and the chat turn starts with at least this left, or nothing is stored
HISTORY_DOCUMENT_CHARS = 100_000        # documents' text a rebuilt history carries, newest first
DOCUMENT_DEADLINE = 'DOCUMENT_DEADLINE'
ATTACHMENTS_LATE = 'Veevee could not read the attachments in time. Nothing was sent; try fewer or shorter PDFs.'
TURN_LATE = 'The agent did not answer in time. Your message is saved; try again in a moment.'


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


def parse_attachments(body):
    """The message's ``attachments`` upload ids, trimmed and deduplicated in order; None when malformed."""
    value = body.get('attachments', [])
    if not isinstance(value, list) or len(value) > MAX_ATTACHMENTS:
        return None
    ids = [item.strip(WHITESPACE) if isinstance(item, str) else '' for item in value]
    return list(dict.fromkeys(ids)) if all(0 < len(item) <= ATTACHMENT_ID_CHARS for item in ids) else None


def attached_document(user_id, asset_id):
    """The user's ready document upload ``asset_id`` through ``media.load``; another user's and an unknown id are the
    same refusal."""
    try:
        asset = media.load(user_id, asset_id)
    except errors.ToolError as error:
        if error.code == errors.NOT_FOUND:
            raise errors.ToolError(errors.NOT_FOUND, f'Attachment {asset_id} is not in your library. Remove it and attach the file again.') from None
        raise
    if asset.kind != 'document':
        raise media.invalid(f'Attachment {asset.id} is {asset.mime}; attach images as reference images.')
    return asset


def described(asset, **kwargs):
    """``media.describe`` on a worker thread, which closes the database connection its usage row opened."""
    try:
        return media.describe(asset, **kwargs)
    finally:
        connections.close_all()


def document_parts(user_id, conversation_id, asset_ids, deadline):
    """``(assets, documents)`` for one message's attached documents: ``{id, text}`` each, the text ``media.untrusted``
    data. Plain text, markdown and docx give their own text; each of at most ``MAX_PDFS`` PDFs one ``media.describe``
    sub-call (usage purpose 'media'), all at once within ``deadline``. Raises ``errors.ToolError``, before
    anything is stored; a PDF without GOOGLE_API_KEY is an explicit refusal, not a skip."""
    assets = [attached_document(user_id, asset_id) for asset_id in asset_ids]
    texts = [media.document_text(asset) for asset in assets]
    pdfs = [asset for asset, text in zip(assets, texts) if text is None]
    if len(pdfs) > MAX_PDFS:
        raise media.invalid(f'A message can carry {MAX_PDFS} PDFs. Remove one and send it again.')
    if pdfs:
        key = os.environ.get('GOOGLE_API_KEY')
        if not key:
            raise errors.ToolError(errors.MODEL_UNAVAILABLE, 'Veevee cannot read PDF attachments: GOOGLE_API_KEY is not set. Ask a Veevee admin.')
        usage = UsageContext(user_id=user_id, conversation_id=uuid.UUID(str(conversation_id)), purpose='media')
        with ThreadPoolExecutor(max_workers=len(pdfs), thread_name_prefix='agent-document') as pool:
            futures = [pool.submit(described, asset, api_key=key, usage=usage, signal=deadline) for asset in pdfs]
        failures = [future.exception() for future in futures if future.exception() is not None]
        if failures and deadline.expired():
            raise errors.ToolError(DOCUMENT_DEADLINE, ATTACHMENTS_LATE)
        if failures:
            raise failures[0]
        results = (future.result() for future in futures)
        texts = [next(results) if text is None else text for text in texts]
    return assets, [{'id': asset.id, 'text': text} for asset, text in zip(assets, texts)]


def document_turn(documents):
    """A user turn's attached documents as Gemini text parts: a line naming each, then its untrusted text."""
    return [part for document in documents for part in ({'text': f'Attached document {document["id"]}:'}, {'text': document['text']})]


def history_turns(turns):
    """``run_turn`` history from ``services.list_turns``: a user message keeps the documents it was sent with, the newest
    in full while their text fits ``HISTORY_DOCUMENT_CHARS`` together, every older one as a one-line note."""
    budget, history = HISTORY_DOCUMENT_CHARS, []
    for turn in reversed(turns):
        parts = []
        for document in reversed(turn['documents']):
            fits = len(document['text']) <= budget
            budget = budget - len(document['text']) if fits else 0
            parts[:0] = document_turn([document]) if fits else [
                {'text': f'Attached document {document["id"]} was attached earlier in this chat; its text is no longer shown.'}]
        history.append({'role': turn['role'], 'content': turn['content'], **({'documents': parts} if parts else {})})
    return history[::-1]


ATTACHMENT_STATUS = {errors.NOT_FOUND: 404, errors.INVALID_INPUT: 400, errors.MODEL_UNAVAILABLE: 503, DOCUMENT_DEADLINE: 504}


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def messages(request, id):
    user = admin(request)
    if user is None:
        return forbidden()
    deadline = media.Deadline(REQUEST_SECONDS)
    conversation = services.get_conversation(id)
    if not conversation:
        return Response({'error': 'Conversation not found.'}, status=404)
    body = body_or_empty(request)
    parsed = parse_message_body(body)
    if 'error' in parsed:
        return Response(parsed, status=400)
    attachments = parse_attachments(body)
    if attachments is None:
        return Response({'error': f'attachments must be a list of at most {MAX_ATTACHMENTS} upload ids.'}, status=400)
    try:
        parts = images_to_parts(parsed['images'])
    except Exception:
        return Response({'error': 'Invalid reference image.'}, status=400)
    try:
        reading = media.Deadline(min(deadline.remaining(), DOCUMENT_SECONDS))
        assets, documents = document_parts(user.id, conversation['id'], attachments, reading)
    except errors.ToolError as error:
        return renew_session(request, Response({'error': error.message}, status=ATTACHMENT_STATUS.get(error.code, 502)))
    if deadline.remaining() < TURN_RESERVE_SECONDS:
        return renew_session(request, Response({'error': ATTACHMENTS_LATE}, status=504))
    for asset in assets:
        media.record_attachment(conversation['id'], asset)
    history = history_turns(services.list_turns(id))
    user_message = services.append_message(id, 'user', parsed['content'], {'documents': documents} if documents else None)
    try:
        result = run_turn(history, parsed['content'], parts, conversation['agentKind'], documents=document_turn(documents), signal=deadline)
        assistant = services.append_message(id, 'assistant', result['reply'], result.get('toolTrace'))
        return renew_session(request, Response({'userMessage': user_message, 'assistantMessage': assistant}))
    except Exception as error:
        logger.warning('agent_turn_failed conversation_id=%s error_type=%s', id, type(error).__name__)
        if deadline.expired():
            return renew_session(request, Response({'userMessage': user_message, 'error': TURN_LATE}, status=504))
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
