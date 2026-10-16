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
from .storage import get_storage, MediaTooLargeError
from .views import _body
from .audio_inputs import capture_audio_input, InvalidAudioType, MAX_AUDIO_BYTES
from .audio_wait import wait_for_audio, AudioResultPending
from apps.generation.services.audio_submission import AUDIO_READY

TRANSCRIPTION_PROMPT = 'Transcribe this audio for use as a video-generation prompt. Return only a clean, timestamped transcript in this exact format, one line per segment: [MM:SS.mmm - MM:SS.mmm] Speaker or sound: words or description. Include meaningful music, ambience, sound effects, pauses, and speaker changes. Do not add a title, markdown fence, commentary, or invented content.'


class GeminiTranscriber:
    """Explicit API key and HTTP transport, allowing golden request qualification."""
    def __init__(self, api_key, transport):
        self.api_key, self.transport = api_key, transport

    def transcribe(self, data, mime_type, model, *, signal=None):
        if not self.api_key:
            raise ValueError('GOOGLE_API_KEY is not configured.')
        payload = {'contents':[{'role':'user','parts':[{'inlineData':{'mimeType':mime_type,'data':data}},
            {'text':TRANSCRIPTION_PROMPT}]}], 'generationConfig':{'temperature':0.1}}
        if signal:
            signal.check()
        arguments=(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
            payload, {'Content-Type':'application/json','x-goog-api-key':self.api_key})
        result = self.transport(*arguments,signal=signal) if signal is not None else self.transport(*arguments)
        parts = ((result.get('candidates') or [{}])[0].get('content') or {}).get('parts') or []
        transcript = '\n'.join(part.get('text','') for part in parts).strip()
        if not transcript:
            raise ValueError('Gemini returned an empty transcription.')
        return transcript


def get_transcriber():
    provider = getattr(settings,'VEEVEE_AUDIO_TRANSCRIBER',None)
    if isinstance(provider,str):
        provider = import_string(provider)
    if provider is None:
        key = getattr(settings,'GOOGLE_API_KEY',None) or os.environ.get('GOOGLE_API_KEY')
        if not key:
            raise ValueError('GOOGLE_API_KEY is not configured.')
        from apps.generation.providers.transport import HttpTransport
        client = HttpTransport(allowed_hosts=['generativelanguage.googleapis.com'],timeout=120)
        def transport(url,payload,headers,*,signal=None):
            response = client.request('POST',url,headers=headers,body=payload,signal=signal)
            if not response.ok:
                raise ValueError(f'Gemini transcription failed ({response.status}).')
            return response.json()
        return GeminiTranscriber(key,transport)
    return provider if hasattr(provider, 'transcribe') and not isinstance(provider, type) else provider()


def configured_transcriber():
    import os
    from apps.generation.providers.transport import HttpTransport, ProviderError, required_key
    key = required_key(os.environ, 'GOOGLE_API_KEY', 'GOOGLE_API_KEY is not configured.')
    client = HttpTransport(allowed_hosts=['generativelanguage.googleapis.com'])
    def request(url, payload, headers, *, signal=None):
        response = client.request('POST', url, headers=headers, body=payload, signal=signal)
        if not response.ok:
            raise ProviderError(f'Gemini transcription failed ({response.status}).', status=response.status)
        return response.json()
    return GeminiTranscriber(key, request)


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
        intent = Generation.objects.create(id=identifier,kind='audio',status='queued',prompt='',
            model=f'Gemini ({model})',aspect_ratio='audio',reference_audios=[ref],project_id=project,
            user_id=user.id,cost_cents=0,cost_basis='estimated',created_at=now,updated_at=now,
            provider_status=AUDIO_READY,submission_input=submission_input)
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
    except Exception as error:
        # Provider exceptions may include tokens/URLs; preserve known public validation only.
        public = 'Transcription failed.'
        if isinstance(error, ValueError) and str(error) in {
            'GOOGLE_API_KEY is not configured.',
            'Gemini returned an empty transcription.',
        }:
            public = str(error)
        return JsonResponse({'error':public},status=500)


def _persist_audio_result(expected, transcript, completed):
    """Fence execution identity; retry local writes without repeating paid I/O."""
    metadata={'project_id','folder_id','location_version','is_favorite','favorited_at',
        'flagged','flagged_at','flag_reason','updated_at'}
    result_fields={'status','prompt','provider_status','completed_at'}
    def identity_matches(row, *, recovered=False):
        ignored=metadata | (result_fields if recovered else set())
        return all(getattr(row,field.attname)==getattr(expected,field.attname)
            for field in Generation._meta.concrete_fields if field.attname not in ignored)
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


def _mark_audio_uncertain(expected):
    """Retain ambiguity without modifying a changed execution or newer metadata."""
    metadata={'project_id','folder_id','location_version','is_favorite','favorited_at',
        'flagged','flagged_at','flag_reason','updated_at'}
    with transaction.atomic():
        row=Generation.objects.select_for_update().filter(pk=expected.id).first()
        if row is None or any(getattr(row,field.attname)!=getattr(expected,field.attname)
                for field in Generation._meta.concrete_fields if field.attname not in metadata):
            return
        Generation.objects.filter(pk=row.id).update(provider_status='SUBMISSION_UNCERTAIN',
            updated_at=max(int(time.time()*1000),row.updated_at+1))
