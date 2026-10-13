"""Original-byte audio snapshots and pre-submission integrity checks."""
import base64
import hashlib
import re
from uuid import uuid4

from .errors import MediaTooLargeError

MAX_AUDIO_BYTES = 15 * 1024 * 1024
AUDIO_EXTENSIONS = {'audio/mpeg':'mp3', 'audio/mp3':'mp3', 'audio/wav':'wav',
    'audio/x-wav':'wav', 'audio/wave':'wav', 'audio/ogg':'ogg', 'audio/webm':'webm',
    'audio/mp4':'m4a', 'audio/x-m4a':'m4a', 'audio/aac':'aac', 'audio/flac':'flac'}


class InvalidAudioType(ValueError):
    pass


def capture_audio_input(storage, reference, identifier, *, model, name):
    """Finish the immutable storage write before any billable call or intent commit.

    Source URLs/data URIs are display provenance only. Execution uses a new
    job-specific object, never a caller-controlled upload key or signed URL.
    """
    raw = storage.read_reference_bytes(reference, max_bytes=MAX_AUDIO_BYTES)
    mime = raw['mimeType'].lower()
    if not isinstance(mime,str) or mime not in AUDIO_EXTENSIONS:
        raise InvalidAudioType('Unsupported audio type.')
    data = raw['bytes']
    if len(data) > MAX_AUDIO_BYTES:
        raise MediaTooLargeError('Audio exceeds its input limit.')
    key = f'references/{identifier}-audio-{uuid4()}.{AUDIO_EXTENSIONS[mime]}'
    # Audio masters must retain the supplied MIME, including audio/mp4 and
    # audio/webm. Generic video extension defaults must not change that type.
    storage.primary.put(key, data, mime, 'public, max-age=31536000, immutable')
    return {'version':2, 'operation':'audio-transcription', 'source':'/api/media/'+key,
        'model':model, 'originalName':name, 'mimeType':mime,
        'byteLength':len(data), 'sha256':hashlib.sha256(data).hexdigest()}


def validated_audio_input(item, storage, *, signal=None):
    """Read and validate the immutable snapshot without invoking a provider."""
    if signal:
        signal.check()
    value = item.submission_input
    if (not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=2
            or value.get('operation')!='audio-transcription'):
        raise ValueError('Unsupported audio intent.')
    mime = value.get('mimeType')
    if not isinstance(mime,str) or mime not in AUDIO_EXTENSIONS:
        raise ValueError('Invalid audio intent MIME.')
    source = value.get('source')
    expected = rf'/api/media/references/{re.escape(str(item.id))}-audio-[0-9a-f-]{{36}}\.{AUDIO_EXTENSIONS[mime]}'
    if not isinstance(source,str) or not re.fullmatch(expected,source):
        raise ValueError('Invalid audio intent source.')
    size, digest, model = value.get('byteLength'), value.get('sha256'), value.get('model')
    if (type(size) is not int or not 0<=size<=MAX_AUDIO_BYTES
            or not isinstance(digest,str) or not re.fullmatch('[0-9a-f]{64}',digest)
            or not isinstance(model,str) or not model or item.model!=f'Gemini ({model})'):
        raise ValueError('Invalid audio intent parameters.')
    raw = storage.read_reference_bytes(source,max_bytes=MAX_AUDIO_BYTES)
    data = raw['bytes']
    if raw['mimeType'].lower()!=mime or len(data)!=size or hashlib.sha256(data).hexdigest()!=digest:
        raise ValueError('Audio snapshot integrity failed.')
    if signal:
        signal.check()
    encoded = base64.b64encode(data).decode()
    del data, raw
    return encoded,mime,model


def transcribe_audio_input(item, provider, storage, *, signal=None):
    """Validate before submitting once; preserve callers without a worker signal."""
    encoded,mime,model=validated_audio_input(item,storage,signal=signal)
    if signal:
        signal.check()
        return provider.transcribe(encoded,mime,model,signal=signal)
    return provider.transcribe(encoded,mime,model)
