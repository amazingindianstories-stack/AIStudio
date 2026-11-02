"""On-demand captions for a board video node. Nothing starts by itself: `quote` only reports what a run would use,
and `generate` runs when an editor asks. It goes through the audio transcription path that already exists (paid
guard, generation worker, Gemini), as the Talktrack transcript does, then turns the timestamped transcript into
WebVTT. The VTT lives in its own table, outside the board JSON, and is served as same-origin text."""
import base64
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4
from django.conf import settings
from django.db import IntegrityError
from .facilitation import FacilitationError
from .media_nodes import MEDIA_PREFIX
from .models import BoardCaption, CanvasBoard
from .talktrack import parse_transcript, transcription_available

MAX_VIDEO_BYTES = 200 * 1024 * 1024
FFMPEG_TIMEOUT_S = 300
MAX_VTT_CHARS = 400_000


def _timestamp(ms):
    hours, rest = divmod(max(0, int(ms)), 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    return f'{hours:02d}:{minutes:02d}:{rest // 1000:02d}.{rest % 1000:03d}'


def vtt_from_segments(segments):
    """WebVTT cues for the transcript's timed segments. Untimed or empty segments are dropped, and a cue that
    would end before it starts is given a short duration, so the file always parses in a browser."""
    cues = []
    for segment in segments:
        text = ' '.join(str(segment.get('text') or '').split()).replace('-->', '->')
        if not text or segment['endMs'] <= 0 and segment['startMs'] <= 0:
            continue
        end = segment['endMs'] if segment['endMs'] > segment['startMs'] else segment['startMs'] + 2000
        speaker = segment.get('speaker') or ''
        if speaker:
            text = f'{speaker}: {text}'
        cues.append(f'{_timestamp(segment["startMs"])} --> {_timestamp(end)}\n{text}')
    return 'WEBVTT\n\n' + '\n\n'.join(cues) + '\n' if cues else ''


def vtt_from_transcript(text):
    return vtt_from_segments(parse_transcript(text))


def media_key(src):
    return src[len(MEDIA_PREFIX):] if isinstance(src, str) and src.startswith(MEDIA_PREFIX) else None


def _video_src(board_id, src):
    """The video node on this board that plays `src`; anything else is not a caption target."""
    key = media_key(src)
    data = CanvasBoard.objects.filter(pk=board_id).values_list('data', flat=True).first()
    nodes = data.get('nodes') if isinstance(data, dict) else None
    if key is None or not any(isinstance(n, dict) and n.get('type') == 'video' and n.get('src') == src for n in nodes or []):
        raise FacilitationError('That video is not on this board.', 404)
    return key


def model_name():
    return getattr(settings, 'AUDIO_TRANSCRIPTION_MODEL', 'gemini-2.5-flash')


def quote(board_id, src):
    """What a run would do, for the cost step that comes before it. No provider call, nothing stored."""
    from apps.media.audio_inputs import MAX_AUDIO_BYTES
    key = _video_src(board_id, src)
    row = BoardCaption.objects.filter(board_id=board_id, media_key=key).first()
    return {'available': transcription_available(), 'exists': row is not None, 'model': f'Gemini ({model_name()})',
            'costCents': 0, 'costBasis': 'estimated', 'maxAudioBytes': MAX_AUDIO_BYTES, 'format': 'webvtt'}


def vtt_for(board_id, src):
    key = media_key(src)
    row = BoardCaption.objects.filter(board_id=board_id, media_key=key).first() if key else None
    if row is None:
        raise FacilitationError('No captions for this video.', 404)
    return row.vtt


def _audio_reference(storage, src):
    """An audio reference for the transcription path: the file itself when it is audio, else the video's audio
    track extracted to a small mono AAC file, handed over as a data URI so no extra object is stored."""
    from apps.media.audio_inputs import AUDIO_EXTENSIONS, MAX_AUDIO_BYTES
    raw = storage.read_reference_bytes(src, max_bytes=MAX_VIDEO_BYTES)
    mime = str(raw['mimeType']).lower()
    if mime in AUDIO_EXTENSIONS:
        return src
    if not mime.startswith('video/'):
        raise FacilitationError('This media cannot be captioned.', 400)
    with tempfile.TemporaryDirectory() as directory:
        source, target = Path(directory, 'in'), Path(directory, 'out.m4a')
        source.write_bytes(raw['bytes'])
        binary = getattr(settings, 'FFMPEG_BINARY', 'ffmpeg')
        try:
            subprocess.run([binary, '-nostdin', '-hide_banner', '-y', '-i', str(source), '-vn', '-ac', '1', '-c:a', 'aac',
                            '-b:a', '48k', '-f', 'ipod', str(target)], capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=True)
        except (subprocess.SubprocessError, OSError):
            raise FacilitationError('This video has no audio track that can be captioned.', 409)
        audio = target.read_bytes()
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise FacilitationError('The video audio is larger than the 15 MB transcription limit.', 413)
    return 'data:audio/mp4;base64,' + base64.b64encode(audio).decode()


def generate(board_id, src, user_id, now):
    """Caption one board video, once. A second call returns the stored captions without another provider job."""
    from apps.generation.services import audio_submission
    from apps.generation.services.audio_submission import AUDIO_READY
    from apps.media.audio_inputs import InvalidAudioType, capture_audio_input
    from apps.media.audio_wait import AudioFailed, AudioResultPending, wait_for_audio
    from apps.media.storage import MediaNotFoundError, MediaTooLargeError, get_storage
    key = _video_src(board_id, src)
    existing = BoardCaption.objects.filter(board_id=board_id, media_key=key).first()
    if existing is not None:
        return existing
    if not transcription_available():
        raise FacilitationError('Captions are not configured.', 503)
    model = model_name()
    identifier, started = uuid4(), int(time.time() * 1000)
    try:
        storage = get_storage()
        reference = _audio_reference(storage, src)
        snapshot = capture_audio_input(storage, reference, identifier, model=model, name='Video captions')
        intent = audio_submission.persist_audio_intent(dict(
            id=identifier, kind='audio', status='queued', prompt='', model=f'Gemini ({model})', aspect_ratio='audio',
            reference_audios=[snapshot['source']], project_id=None, user_id=user_id, cost_cents=0,
            cost_basis='estimated', created_at=started, updated_at=started, provider_status=AUDIO_READY, submission_input=snapshot))
        saved = wait_for_audio(intent)
    except MediaNotFoundError:
        raise FacilitationError('That video could not be found.', 404)
    except MediaTooLargeError:
        raise FacilitationError('The video is too large to caption.', 413)
    except InvalidAudioType:
        raise FacilitationError('The audio type cannot be captioned.', 400)
    except AudioResultPending as error:
        raise FacilitationError(str(error), 504)
    except AudioFailed as error:
        raise FacilitationError(str(error), 429 if error.busy else 502)
    vtt = vtt_from_transcript(saved.prompt)
    if not vtt or len(vtt) > MAX_VTT_CHARS:
        raise FacilitationError('No speech could be captioned in this video.', 422)
    try:
        return BoardCaption.objects.create(board_id=board_id, actor_id=user_id, media_key=key, vtt=vtt, created_at=now)
    except IntegrityError:
        return BoardCaption.objects.get(board_id=board_id, media_key=key)
