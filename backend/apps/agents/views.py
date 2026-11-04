import math
import os
import uuid
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.responses import renew_session
from apps.generation.models import Generation
from apps.generation.watermark import WHITESPACE
from apps.library.views import body_or_empty
from apps.mcp import errors
from apps.media.keys import media_key_from_ref
from apps.media.models import UploadSession
from . import limits, media, runner, runs, services
from .events import PAGE_SIZE
from .grants import AgentGrantInvalid
from .images import parse_message_body
from .loop_llm import LOOP_MODELS, VOICE_MIME, UsageContext

MAX_ATTACHMENTS = 10                    # the composer's MAX_DOCUMENTS (src/lib/agent-attachments.js)
ATTACHMENT_ID_CHARS = 64


def forbidden():
    return Response({'error': 'FORBIDDEN'}, status=403)


def agents_disabled():
    return Response({'error': 'Agents are turned off.', 'code': 'AGENTS_DISABLED'}, status=403)


def agent_user(request):
    """``(user, None)`` when the session's user may use the Agents tab (``limits.agents_enabled``), else ``(None, 403)``."""
    user = lookup(request)
    if user is None:
        return None, forbidden()
    if not limits.agents_enabled(user):
        return None, agents_disabled()
    return user, None


def visible(user, conversation_id):
    """The conversation's JSON when ``user`` owns it; admins included, nobody sees another user's conversation."""
    row = runs.owned_conversation(conversation_id, user)
    return services.conversation_json(row) if row is not None else None


def first(request, key):
    values = request.query_params.getlist(key)
    return values[0] if values else None


def name_value(value):
    return (value or '').strip(WHITESPACE)


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def conversations(request):
    user, refused = agent_user(request)
    if refused is not None:
        return refused
    if request.method == 'GET':
        project, kind = first(request, 'projectId'), first(request, 'agentKind')
        if not project:
            return Response({'error': 'projectId required.'}, status=400)
        if kind not in ('image', 'video'):
            return Response({'error': "agentKind must be 'image' or 'video'."}, status=400)
        return renew_session(request, Response({'conversations': services.list_conversations(project, kind, owner=user.id)}))
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
        return renew_session(request, Response({'conversations': services.list_conversations(project, kind, owner=user.id), 'conversation': conversation}))
    if operation in ('renameConversation', 'deleteConversation'):
        if not body.get('id'):
            return Response({'error': 'id required.'}, status=400)
        existing = visible(user, body['id'])
        if not existing:
            return Response({'error': 'Conversation not found.'}, status=404)
        if operation == 'renameConversation':
            services.rename_conversation(body['id'], name_value(body.get('name')))
        else:
            services.delete_conversation(body['id'])
        return renew_session(request, Response({'conversations': services.list_conversations(existing['projectId'], existing['agentKind'], owner=user.id)}))
    return Response({'error': 'Unknown op.'}, status=400)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def detail(request, id):
    user, refused = agent_user(request)
    if refused is not None:
        return refused
    conversation = visible(user, id)
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


ATTACHMENT_STATUS = {errors.BUDGET_EXCEEDED: 429, errors.NOT_FOUND: 404, errors.INVALID_INPUT: 400, errors.MODEL_UNAVAILABLE: 503}


@api_view(['PATCH'])
@authentication_classes([])
@permission_classes([])
def attach(request, id, message_id):
    user, refused = agent_user(request)
    if refused is not None:
        return refused
    if not visible(user, id):
        return Response({'error': 'Conversation not found.'}, status=404)
    body = body_or_empty(request)
    generated = body.get('generatedItemId').strip(WHITESPACE) if isinstance(body.get('generatedItemId'), str) else ''
    if not generated:
        return Response({'error': 'generatedItemId is required.'}, status=400)
    message = services.attach_generated_item(id, message_id, generated)
    if not message:
        return Response({'error': 'Message not found.'}, status=404)
    return renew_session(request, Response({'message': message}))


# Agent runs: the durable loop the agent worker advances. Each route needs a session with the Agents tab on (as above)
# and the conversation's owner; another user's conversation or run answers 404, as if it did not exist.

def owned(request, id):
    """``(user, conversation, None)``, or ``(None, None, response)`` when the caller may not use the conversation."""
    user, refused = agent_user(request)
    if refused is not None:
        return None, None, refused
    conversation = runs.owned_conversation(id, user)
    if conversation is None:
        return None, None, Response({'error': 'Conversation not found.'}, status=404)
    return user, conversation, None


def owned_run(request, id, run_id):
    user, conversation, refused = owned(request, id)
    if refused is not None:
        return None, None, refused
    run = runs.conversation_run(conversation, run_id)
    if run is None:
        return None, None, Response({'error': 'Run not found.'}, status=404)
    return user, run, None


def bounded_int(value, default, low, high):
    if value is None:
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def transcribe(request, id):
    """GET: the voice note caps. POST: the raw recording (its own Content-Type, ``durationMs`` in the query) as
    ``{transcript}``; raw bytes keep a 4 MB note under Vercel's 4.5 MB request body, which base64 would not. The audio
    goes to Gemini only: no upload session, no storage write, and neither it nor the transcript is logged."""
    user, _, refused = owned(request, id)
    if refused is not None:
        return refused
    max_seconds, max_bytes = media.limit(user.id, 'agentVoiceMaxSeconds'), media.limit(user.id, 'agentVoiceMaxBytes')
    if request.method == 'GET':
        return renew_session(request, Response({'maxSeconds': max_seconds, 'maxBytes': max_bytes}))
    if not limits.agents_enabled(user):
        return agents_disabled()
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
    try:
        transcript = media.transcribe(mime, audio, api_key=key, usage=usage)
    except errors.ToolError as error:
        return renew_session(request, Response({'error': error.message}, status=429))
    if transcript is None:
        return renew_session(request, Response({'error': 'Veevee could not transcribe the voice note. Try again.'}, status=502))
    return renew_session(request, Response({'transcript': transcript}))


def reference_asset(user_id, ref):
    """The stored reference image ``ref`` (by its media URL) as a ``media.Asset``: the user's ready upload, or any
    finished image generation the shared library holds, as ``media.load`` reads them. A data URL is refused: a run keeps
    ids, not bytes, so the composer uploads it first."""
    if ref.startswith('data:'):
        raise media.invalid('Upload reference images before you send them to the agent.')
    cdn = getattr(settings, 'GCP_MEDIA_CDN_URL', '')
    key = media_key_from_ref(ref, cdn)
    if not key:
        raise media.invalid('Use stored reference images.')
    identifier = (UploadSession.objects.filter(key=key, actor_id=user_id, state='ready', finalized_at__isnull=False)
                  .values_list('id', flat=True).first())
    if identifier is None:
        rows = Generation.objects.filter(status='succeeded', kind='image', url__endswith=key).values_list('id', 'url')
        identifier = next((generation for generation, url in rows if media_key_from_ref(url, cdn) == key), None)
    if identifier is None:
        raise errors.ToolError(errors.NOT_FOUND, 'A reference image is not in the library. Remove it and attach it again.')
    asset = media.load(user_id, identifier)
    if asset.kind != 'image':
        raise media.invalid(f'Reference {asset.id} is {asset.mime}; attach it as a file instead.')
    return asset


def upload_name(asset):
    """The filename the artist uploaded ``asset`` under; '' for a generation."""
    return UploadSession.objects.filter(id=asset.id).values_list('filename', flat=True).first() or ''


def run_attachments(user_id, attachment_ids, refs):
    """``(assets, attachments)`` for a run message: its document uploads (``attached_document``, as /messages checks
    them) and its reference images, deduplicated by id, with the ``media.attachment_json`` each stores. Nothing is
    read for the model here; the run opens each with read_document or view_media. Raises ``errors.ToolError``."""
    found = [attached_document(user_id, asset_id) for asset_id in attachment_ids] + [reference_asset(user_id, ref) for ref in refs]
    assets = list({asset.id: asset for asset in found}.values())
    return assets, [media.attachment_json(asset, upload_name(asset)) for asset in assets]


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def agent_runs(request, id):
    user, conversation, refused = owned(request, id)
    if refused is not None:
        return refused
    if request.method == 'GET':
        return renew_session(request, Response({'runs': runs.recent_runs(conversation)}))
    body = body_or_empty(request)
    parsed = parse_message_body(body)
    if 'error' in parsed:
        return Response(parsed, status=400)
    if body.get('model') is not None and body['model'] not in LOOP_MODELS:
        return Response({'error': 'Unknown model.'}, status=400)
    attachment_ids = parse_attachments(body)
    if attachment_ids is None:
        return Response({'error': f'attachments must be a list of at most {MAX_ATTACHMENTS} upload ids.'}, status=400)
    try:
        assets, attachments = run_attachments(user.id, attachment_ids, parsed['images'])
    except errors.ToolError as error:
        return renew_session(request, Response({'error': error.message}, status=ATTACHMENT_STATUS.get(error.code, 502)))
    try:
        outcome = runs.post_message(conversation, user, parsed['content'], model=body.get('model'), attachments=attachments)
    except runs.AgentsDisabled:
        return agents_disabled()
    except runs.RunLimitReached as error:
        return Response({'error': error.hit.message, 'code': 'AGENT_LIMIT', 'kind': error.hit.kind}, status=429)
    except AgentGrantInvalid as error:
        return Response({'error': str(error), 'code': 'AGENT_GRANT_INVALID'}, status=403)
    for asset in assets:
        media.record_attachment(conversation.id, asset, run_id=outcome['run']['id'])
    return renew_session(request, Response(outcome, status=201 if outcome['delivery'] == 'run' else 202))


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def run_events(request, id, run_id):
    _, run, refused = owned_run(request, id, run_id)
    if refused is not None:
        return refused
    after = bounded_int(first(request, 'after'), 0, 0, 2 ** 31 - 1)
    limit = bounded_int(first(request, 'limit'), PAGE_SIZE, 1, PAGE_SIZE)
    if after is None or limit is None:
        return Response({'error': f'after must be a non-negative integer and limit 1-{PAGE_SIZE}.'}, status=400)
    return renew_session(request, Response(runs.feed(run, after=after, limit=limit)))


def step_index(body):
    value = body.get('stepIndex')
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def run_quote(request, id, run_id, decision):
    user, run, refused = owned_run(request, id, run_id)
    if refused is not None:
        return refused
    index = step_index(body_or_empty(request))
    if index is None:
        return Response({'error': 'stepIndex is required.'}, status=400)
    if decision == 'approve':
        answered = runner.approve_quote(run.id, user.id, step_index=index)
    else:
        answered = runner.decline_quote(run.id, 'declined', step_index=index)
    if answered is None:
        return Response({'error': 'No quote is waiting for approval at this step.', 'code': 'NO_PENDING_QUOTE'}, status=409)
    return renew_session(request, Response({'run': runs.run_json(answered)}))


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def run_cancel(request, id, run_id):
    _, run, refused = owned_run(request, id, run_id)
    if refused is not None:
        return refused
    cancel_jobs = body_or_empty(request).get('cancelJobs', False)
    if not isinstance(cancel_jobs, bool):
        return Response({'error': 'cancelJobs must be true or false.'}, status=400)
    cancelled = runs.request_cancel(run.id, cancel_jobs=cancel_jobs)
    if cancelled is None:
        return Response({'error': 'This run has already finished.', 'code': 'RUN_FINISHED'}, status=409)
    return renew_session(request, Response({'run': runs.run_json(cancelled)}, status=202))
