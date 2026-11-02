"""On-demand captions for a board video node. Nothing starts by itself: `quote` only reports what a run would use,
and `generate` runs when an editor asks. It goes through the audio transcription path that already exists (paid
guard, generation worker, Gemini), as the Talktrack transcript does, then turns the timestamped transcript into
WebVTT. The VTT lives in its own table, outside the board JSON, and is served as same-origin text. The caption row
is committed with its transcription job, so a run that outlives its request is finished by a later quote, never
submitted twice. A run is marked failed only once its job failed, was cancelled, or stayed uncertain past
`UNCERTAIN_GRACE_MS`, and only then can an editor start another."""
import base64
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4
from django.conf import settings
from django.db import IntegrityError, transaction
from .facilitation import FacilitationError
from .media_nodes import MEDIA_PREFIX
from .models import BoardCaption, CanvasBoard
from .talktrack import parse_transcript, transcription_available

MAX_VIDEO_BYTES = 200 * 1024 * 1024
FFMPEG_TIMEOUT_S = 60
# The request answers within this, inside the gateway's 125 s wait; a run still going then is finished later.
BUDGET_S = 110
# The audio job's own 120 s provider timeout, plus a wide margin before an unresolved submission counts as failed.
UNCERTAIN_GRACE_MS = (120 + 30 * 60) * 1000
MAX_VTT_CHARS = 400_000


def _timestamp(ms):
    hours, rest = divmod(max(0, int(ms)), 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    return f'{hours:02d}:{minutes:02d}:{rest // 1000:02d}.{rest % 1000:03d}'


def _cue_text(value):
    """Plain cue text: `&`, `<` and `>` would start a character reference or a tag, which also covers `-->`."""
    text = ' '.join(str(value or '').split())
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def vtt_from_segments(segments):
    """WebVTT cues for the transcript's timed segments. Untimed or empty segments are dropped, and a cue that
    would end before it starts is given a short duration, so the file always parses in a browser."""
    cues = []
    for segment in segments:
        text = _cue_text(segment.get('text'))
        if not text or segment['endMs'] <= 0 and segment['startMs'] <= 0:
            continue
        end = segment['endMs'] if segment['endMs'] > segment['startMs'] else segment['startMs'] + 2000
        speaker = _cue_text(segment.get('speaker'))
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


def quote(board_id, src, now):
    """What a run would do, for the cost step that comes before it. No provider call; a run in flight is finished
    here once its job has ended, and a failed run reports why."""
    from apps.media.audio_inputs import MAX_AUDIO_BYTES
    key = _video_src(board_id, src)
    row = BoardCaption.objects.filter(board_id=board_id, media_key=key).first()
    if row is not None:
        try:
            row = _settle(row, now)
        except FacilitationError:
            row = BoardCaption.objects.filter(pk=row.pk).first()
    return {'available': transcription_available(), 'exists': bool(row and row.vtt),
            'pending': bool(row and not row.vtt and not row.error), 'failure': row.error if row else '',
            'model': f'Gemini ({model_name()})', 'costCents': 0, 'costBasis': 'estimated', 'maxAudioBytes': MAX_AUDIO_BYTES,
            'format': 'webvtt'}


def vtt_for(board_id, src):
    key = media_key(src)
    row = BoardCaption.objects.filter(board_id=board_id, media_key=key).exclude(vtt='').first() if key else None
    if row is None:
        raise FacilitationError('No captions for this video.', 404)
    return row.vtt


def _audio_reference(storage, key, deadline):
    """An audio reference for the transcription path: the video's audio track extracted to a small mono AAC file,
    handed over as a data URI so no extra object is stored. The video is streamed to a temporary file, never held in
    memory."""
    from apps.media.audio_inputs import MAX_AUDIO_BYTES
    from urllib.parse import unquote
    from apps.media.errors import MediaTooLargeError
    from apps.media.keys import InvalidMediaKey
    from apps.media.views import MediaHidden, authorize_media_key
    try:
        key = authorize_media_key(unquote(key))
    except (MediaHidden, InvalidMediaKey):
        raise FacilitationError('That video could not be found.', 404)
    with tempfile.TemporaryDirectory() as directory:
        source, target = Path(directory, 'in'), Path(directory, 'out.m4a')
        media = storage.open(key)
        try:
            if not str(media.content_type).lower().startswith('video/'):
                raise FacilitationError('This media cannot be captioned.', 400)
            if media.content_length > MAX_VIDEO_BYTES:
                raise MediaTooLargeError('Media exceeds the configured input size limit.')
            with source.open('wb') as staged:
                for chunk in media.stream:
                    if staged.tell() + len(chunk) > MAX_VIDEO_BYTES:
                        raise MediaTooLargeError('Media exceeds the configured input size limit.')
                    staged.write(chunk)
        finally:
            media.stream.close()
        binary = getattr(settings, 'FFMPEG_BINARY', 'ffmpeg')
        try:
            subprocess.run([binary, '-nostdin', '-hide_banner', '-y', '-i', str(source), '-vn', '-ac', '1', '-c:a', 'aac',
                            '-b:a', '48k', '-f', 'ipod', str(target)], capture_output=True, check=True,
                           timeout=min(FFMPEG_TIMEOUT_S, max(1, deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            raise FacilitationError('This video took too long to prepare for captions.', 504)
        except (subprocess.SubprocessError, OSError):
            raise FacilitationError('This video has no audio track that can be captioned.', 409)
        audio = target.read_bytes()
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise FacilitationError('The video audio is larger than the 15 MB transcription limit.', 413)
    return 'data:audio/mp4;base64,' + base64.b64encode(audio).decode()


def _settle(row, now, timeout=0):
    """Follow a row's transcription job for up to `timeout` seconds. The row gets its VTT once the job succeeded. It
    is marked failed, with the reason raised, once the job failed, was cancelled or is gone, or its submission stayed
    uncertain past `UNCERTAIN_GRACE_MS`. While the job is queued or running, the row is returned as it is."""
    from apps.generation.models import Generation
    from apps.media.audio_wait import AudioFailed, AudioResultPending, wait_for_audio
    if row.vtt or row.error:
        return row
    run = BoardCaption.objects.filter(pk=row.pk, generation_id=row.generation_id, vtt='', error='')
    try:
        job = Generation.objects.filter(pk=row.generation_id).first()
        if job is None:
            raise FacilitationError('The caption run is gone.', 409)
        try:
            saved = wait_for_audio(job, timeout=timeout)
        except AudioResultPending:
            job = Generation.objects.filter(pk=job.pk).first()
            if job is None:
                raise FacilitationError('The caption run is gone.', 409)
            if job.provider_status == 'SUBMISSION_UNCERTAIN':
                if now - job.updated_at <= UNCERTAIN_GRACE_MS:
                    return row
                raise FacilitationError('The caption run could not be confirmed.', 504)
            if job.status == 'cancelled':
                raise FacilitationError('The caption run was cancelled.', 409)
            return row
        except AudioFailed as error:
            raise FacilitationError(str(error), 429 if error.busy else 502)
        except RuntimeError:
            raise FacilitationError('The caption run could not be checked.', 502)
        vtt = vtt_from_transcript(saved.prompt)
        if not vtt or len(vtt) > MAX_VTT_CHARS:
            raise FacilitationError('No speech could be captioned in this video.', 422)
    except FacilitationError as error:
        run.update(error=error.error)
        raise
    run.update(vtt=vtt)
    return BoardCaption.objects.get(pk=row.pk)


def generate(board_id, src, user_id, now):
    """Caption one board video, once. A later call returns the stored captions, or the run still in flight,
    without another provider job; only a failed run is taken over by a new one."""
    from apps.generation.services import audio_submission
    from apps.generation.services.audio_submission import AUDIO_READY
    from apps.media.audio_inputs import InvalidAudioType, capture_audio_input
    from apps.media.storage import MediaNotFoundError, MediaTooLargeError, get_storage
    deadline = time.monotonic() + BUDGET_S
    key = _video_src(board_id, src)
    existing = BoardCaption.objects.filter(board_id=board_id, media_key=key).first()
    if existing is not None:
        try:
            existing = _settle(existing, now)
        except FacilitationError:
            existing = BoardCaption.objects.get(pk=existing.pk)
        if not existing.error:
            return existing
    if not transcription_available():
        raise FacilitationError('Captions are not configured.', 503)
    model = model_name()
    identifier, started = uuid4(), int(time.time() * 1000)
    try:
        storage = get_storage()
        reference = _audio_reference(storage, key, deadline)
        snapshot = capture_audio_input(storage, reference, identifier, model=model, name='Video captions')
    except MediaNotFoundError:
        raise FacilitationError('That video could not be found.', 404)
    except MediaTooLargeError:
        raise FacilitationError('The video is too large to caption.', 413)
    except InvalidAudioType:
        raise FacilitationError('The audio type cannot be captioned.', 400)
    try:
        with transaction.atomic():
            if existing is None:
                BoardCaption.objects.create(board_id=board_id, actor_id=user_id, media_key=key, generation_id=identifier,
                                            created_at=now)
            elif not BoardCaption.objects.filter(pk=existing.pk, generation_id=existing.generation_id).update(
                    generation_id=identifier, actor_id=user_id, error='', created_at=now):
                raise IntegrityError('Another run took over this caption.')
            audio_submission.persist_audio_intent(dict(
                id=identifier, kind='audio', status='queued', prompt='', model=f'Gemini ({model})', aspect_ratio='audio',
                reference_audios=[snapshot['source']], project_id=None, user_id=user_id, cost_cents=0,
                cost_basis='estimated', created_at=started, updated_at=started, provider_status=AUDIO_READY,
                submission_input=snapshot))
    except IntegrityError:
        pass
    row = _settle(BoardCaption.objects.get(board_id=board_id, media_key=key), now, max(0, deadline - time.monotonic()))
    if row.error:
        raise FacilitationError(row.error, 409)
    return row
