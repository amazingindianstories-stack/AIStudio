"""Audio transcription contract with injectable provider; no implicit external calls."""
import os
import time
from uuid import uuid4
from django.conf import settings
from django.db import OperationalError, InterfaceError, transaction
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods
from django.utils.module_loading import import_string
from apps.authentication.session import lookup
from apps.generation.models import Generation
from apps.library.services.naming import same_execution_identity
from .storage import get_storage, MediaTooLargeError
from .views import _body
from .audio_inputs import capture_audio_input, InvalidAudioType, MAX_AUDIO_BYTES
from .audio_wait import wait_for_audio, AudioResultPending, AudioFailed
from apps.generation.services import audio_submission
from apps.generation.services.audio_submission import AUDIO_READY

TRANSCRIPTION_PROMPT = 'Transcribe this audio for use as a video-generation prompt. Return only a clean, timestamped transcript in this exact format, one line per segment: [MM:SS.mmm - MM:SS.mmm] Speaker or sound: words or description. Include meaningful music, ambience, sound effects, pauses, and speaker changes. Do not add a title, markdown fence, commentary, or invented content.'


MISSING_KEY = 'GOOGLE_API_KEY is not configured.'
VERTEX_MISSING = 'Vertex AI is not configured.'


def transcription_endpoint(model):
    from apps.integrations import google_genai
    return google_genai.model_url(model)


class GeminiTranscriber:
    """Explicit credentials and HTTP transport, allowing golden request qualification. ``auth`` returns a request's
    credential header (Vertex AI mints its bearer token per call); without it the API key is sent."""
    def __init__(self, api_key, transport, *, auth=None):
        self.api_key, self.transport, self.auth = api_key, transport, auth

    def transcribe(self, data, mime_type, model, *, signal=None):
        if not self.api_key and self.auth is None:
            raise ValueError(MISSING_KEY)
        payload = {'contents':[{'role':'user','parts':[{'inlineData':{'mimeType':mime_type,'data':data}},
            {'text':TRANSCRIPTION_PROMPT}]}], 'generationConfig':{'temperature':0.1}}
        if signal:
            signal.check()
        credentials = self.auth() if self.auth is not None else {'x-goog-api-key':self.api_key}
        arguments=(transcription_endpoint(model),
            payload, {'Content-Type':'application/json',**credentials})
        result = self.transport(*arguments,signal=signal) if signal is not None else self.transport(*arguments)
        parts = ((result.get('candidates') or [{}])[0].get('content') or {}).get('parts') or []
        transcript = '\n'.join(part.get('text','') for part in parts).strip()
        if not transcript:
            raise ValueError('Gemini returned an empty transcription.')
        return transcript


def transcription_error(response):
    """The provider's refusal of a transcription, with its exact record (code, message, request id)."""
    from apps.generation import provider_errors
    from apps.integrations.transport import ProviderError
    return ProviderError(f'Gemini transcription failed ({response.status}).', status=response.status,
                         provider_response=provider_errors.capture('gemini', phase='transcribe', status=response.status,
                                                                   body=response.text, headers=response.headers))


def get_transcriber():
    provider = getattr(settings,'VEEVEE_AUDIO_TRANSCRIBER',None)
    if isinstance(provider,str):
        provider = import_string(provider)
    if provider is None:
        from apps.integrations import google_genai
        if google_genai.is_vertex():
            if not google_genai.configured():
                raise ValueError(VERTEX_MISSING)
            return _http_transcriber(None, timeout=120, auth=google_genai.auth_headers)
        key = getattr(settings,'GOOGLE_API_KEY',None) or os.environ.get('GOOGLE_API_KEY')
        if not key:
            raise ValueError(MISSING_KEY)
        return _http_transcriber(key, timeout=120)
    return provider if hasattr(provider, 'transcribe') and not isinstance(provider, type) else provider()


def configured_transcriber():
    from apps.integrations import google_genai
    from apps.integrations.transport import required_key
    if google_genai.is_vertex():
        if not google_genai.configured():
            raise ValueError(VERTEX_MISSING)
        return _http_transcriber(None, auth=google_genai.auth_headers)
    return _http_transcriber(required_key(os.environ, 'GOOGLE_API_KEY', MISSING_KEY))


def _http_transcriber(key, *, timeout=60, auth=None):
    """A ``GeminiTranscriber`` posting through the provider transport to the active backend's host."""
    from apps.integrations import google_genai
    from apps.integrations.transport import HttpTransport
    client = HttpTransport(allowed_hosts=google_genai.hosts(),timeout=timeout)
    def request(url,payload,headers,*,signal=None):
        response = client.request('POST',url,headers=headers,body=payload,signal=signal)
        if not response.ok:
            raise transcription_error(response)
        return response.json()
    return GeminiTranscriber(key,request,auth=auth)


@transaction.non_atomic_requests
@require_http_methods(['POST'])
def transcribe(request):
    user = lookup(request)
    if not user:
        return JsonResponse({'error':'UNAUTHENTICATED'},status=401)
    body = _body(request)
    ref = body.get('audioRef') if isinstance(body.get('audioRef'),str) else ''
    name = body.get('name')[:200] if isinstance(body.get('name'),str) else 'audio'
    project = body.get('projectId','').strip() if isinstance(body.get('projectId'),str) else None
    project = project or None
    if not ref:
        return JsonResponse({'error':'Audio reference is required.'},status=400)
    intent = None
    try:
        model = getattr(settings,'AUDIO_TRANSCRIPTION_MODEL','gemini-2.5-flash')
        identifier, now = uuid4(), int(time.time()*1000)
        storage = get_storage()
        submission_input = capture_audio_input(storage,ref,identifier,model=model,name=name)
        # Commit before worker I/O; this handler only waits for durable results.
        intent = audio_submission.persist_audio_intent(dict(id=identifier,kind='audio',status='queued',prompt='',
            model=f'Gemini ({model})',aspect_ratio='audio',reference_audios=[ref],project_id=project,
            user_id=user.id,cost_cents=0,cost_basis='estimated',created_at=now,updated_at=now,
            provider_status=AUDIO_READY,submission_input=submission_input))
        saved = wait_for_audio(intent)
        transcript = saved.prompt
        item = {'id':str(identifier),'kind':'audio','status':'succeeded','prompt':transcript,
            'model':f'Gemini ({model})','aspectRatio':'audio','resolution':None,'duration':None,
            'referenceAudios':[ref],'projectId':str(saved.project_id) if saved.project_id else None,'productionMetadata':{'type':'audio-transcription',
            'originalName':name,'transcript':transcript,'sourceAudio':ref},'userId':str(user.id),
            'costCents':0,'costBasis':'estimated','createdAt':now,'updatedAt':saved.updated_at}
        return JsonResponse({**item,'transcript':transcript})
    except MediaTooLargeError:
        return JsonResponse({'error':'Audio files must be 15 MB or smaller.'},status=413)
    except InvalidAudioType:
        return JsonResponse({'error':'Use a common audio file such as MP3, WAV, M4A, OGG, AAC, FLAC or WebM.'},status=400)
    except AudioResultPending as error:
        return JsonResponse({'error':str(error),'id':str(error.identifier)},status=504)
    except AudioFailed as error:
        return JsonResponse({'error':str(error),'id':str(error.identifier)},status=429 if error.busy else 502)
    except Exception as error:
        # Provider exceptions may include tokens/URLs; preserve known public validation only.
        public = 'Transcription failed.'
        if isinstance(error, ValueError) and str(error) in {
            MISSING_KEY,
            VERTEX_MISSING,
            'Gemini returned an empty transcription.',
        }:
            public = str(error)
        return JsonResponse({'error':public},status=500)


def _persist_audio_result(expected, transcript, completed):
    """Fence execution identity; retry local writes without repeating paid I/O."""
    result_fields={'status','prompt','provider_status','completed_at'}
    def identity_matches(row, *, recovered=False):
        return same_execution_identity(row, expected, ignored=result_fields if recovered else ())
    def acknowledged(row):
        return (identity_matches(row,recovered=True) and row.status=='succeeded'
            and row.prompt==transcript and row.provider_status=='COMPLETED'
            and row.completed_at==completed)
    for attempt in range(3):
        try:
            with transaction.atomic():
                row=Generation.objects.select_for_update().get(pk=expected.id)
                if acknowledged(row):
                    return row
                if not identity_matches(row):
                    raise RuntimeError('Audio execution identity changed.')
                Generation.objects.filter(pk=row.id).update(status='succeeded',prompt=transcript,
                    provider_status='COMPLETED',completed_at=completed,
                    updated_at=max(completed,row.updated_at+1))
                row=Generation.objects.get(pk=row.id)
            return row
        except (OperationalError,InterfaceError):
            try:
                row=Generation.objects.get(pk=expected.id)
                if acknowledged(row):
                    return row
            except (OperationalError,InterfaceError):
                pass
            if attempt==2:
                raise


def _mark_audio_uncertain(expected, *, code='audio_submission_uncertain', now=None):
    """End the local attempt, preserving remote ambiguity and one-shot evidence."""
    with transaction.atomic():
        row=Generation.objects.select_for_update().filter(pk=expected.id).first()
        if row is None or not same_execution_identity(row, expected):
            return
        from apps.generation.services.audio_submission import AUDIO_UNCERTAIN_MESSAGE
        now = int(time.time()*1000) if now is None else now
        record = {'provider':'gemini', 'source':'veevee', 'phase':'transcribe',
                  'code':code, 'receivedAt':now}
        Generation.objects.filter(pk=row.id).update(status='failed',
            provider_status='SUBMISSION_UNCERTAIN', error=AUDIO_UNCERTAIN_MESSAGE,
            completed_at=now, next_poll_at=None,
            provider_responses=[*(row.provider_responses or []), record],
            updated_at=max(now,row.updated_at+1))


def _mark_audio_failed(expected, message, responses=None):
    """A definite provider refusal: the row ends failed and its audio capacity is released."""
    with transaction.atomic():
        row=Generation.objects.select_for_update().filter(pk=expected.id).first()
        if row is None or not same_execution_identity(row, expected):
            return
        now=int(time.time()*1000)
        Generation.objects.filter(pk=row.id).update(status='failed',error=message,provider_status='REJECTED',
            **({'provider_responses':responses} if responses else {}),
            completed_at=now,updated_at=max(now,row.updated_at+1))
