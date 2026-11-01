"""Talktrack (area D): recorded walk-throughs of a board.

The browser records with MediaRecorder and uploads through the existing resumable upload path (purpose
`talktrack`); `register` then copies the finished upload to `talktrack/<board>/<uuid>.<ext>`, the same step
`board_upload` does for images. Trim is stored as playback offsets (the file is never touched). Cutting the
middle out and the one-time remux that makes a MediaRecorder file seekable are ffmpeg jobs the scheduler worker
runs (`process_jobs`). A transcript is made only when someone asks for it, through the audio transcription path
that already exists, so nothing paid starts by itself.
"""
import re
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4
from django.conf import settings
from django.db import transaction
from django.db.models import Count, Q, Sum
from .models import Talktrack, TalktrackMoment, TalktrackView
from .facilitation import FacilitationError

MAX_DURATION_MS = 4 * 60 * 60 * 1000
TITLE_LIMIT = 120
COMMENT_LIMIT = 500
EMOJIS = ('👍', '❤️', '😂', '🎉', '👏', '🤔', '🔥', '👀')
JOB_STATUSES = ('processing', 'cutting')
WORKING = 'working:'
STALE_JOB_MS = 30 * 60 * 1000
MIME_EXTENSIONS = {'video/webm': 'webm', 'video/mp4': 'mp4', 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg'}
CHAPTER_WINDOW_MS = 60_000


def _whole(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or not low <= value <= high:
        raise FacilitationError(f'{name} must be a whole number from {low} to {high}.')
    return int(value)


def _title(value, fallback='Talktrack'):
    text = value.strip()[:TITLE_LIMIT] if isinstance(value, str) else ''
    return text or fallback


def _row(board_id, talktrack_id):
    from .views import UUID_PATTERN
    if not isinstance(talktrack_id, str) or not UUID_PATTERN.fullmatch(talktrack_id):
        raise FacilitationError('Talktrack not found.', 404)
    row = Talktrack.objects.filter(pk=talktrack_id, board_id=board_id).first()
    if row is None:
        raise FacilitationError('Talktrack not found.', 404)
    return row


def effective_range(row):
    """The playback window in the file: the trim offsets, clamped to the recording."""
    end = row.duration_ms if row.trim_end_ms is None else min(row.trim_end_ms, row.duration_ms)
    return max(0, row.trim_start_ms), end


def transcription_available():
    return bool(getattr(settings, 'GOOGLE_API_KEY', None) or __import__('os').environ.get('GOOGLE_API_KEY'))


def to_dict(row, viewers=None, mine=None):
    start, end = effective_range(row)
    result = {'id': str(row.id), 'boardId': str(row.board_id), 'ownerId': str(row.owner_id), 'title': row.title,
              'url': '/api/media/' + row.key, 'mime': row.mime, 'size': row.size, 'durationMs': row.duration_ms,
              'trimStartMs': start, 'trimEndMs': end, 'status': row.status.removeprefix(WORKING),
              'hasAudio': bool(row.audio_key), 'transcript': row.transcript, 'summary': row.summary,
              'chapters': row.chapters, 'createdAt': row.created_at, 'updatedAt': row.updated_at}
    if viewers is not None:
        result['viewerCount'] = viewers
    if mine is not None:
        result['myWatchedMs'] = mine
    return result


def _copy_upload(actor_id, reference_id, board_id, purposes=frozenset({'talktrack'})):
    """Copy a finished upload into the board's talktrack namespace. Returns (key, mime, size)."""
    from apps.media.storage import get_storage
    from apps.media.uploads import UploadError, resolve_ready_upload
    try:
        upload = resolve_ready_upload(str(actor_id), reference_id, purposes=set(purposes))
    except UploadError as error:
        raise FacilitationError(str(error), error.status)
    mime = upload.content_type.split(';')[0].strip().lower()
    extension = MIME_EXTENSIONS.get(mime)
    if extension is None:
        raise FacilitationError('Unsupported recording type.', 400)
    storage = get_storage()
    key = f'talktrack/{board_id}/{uuid4()}.{extension}'
    media = storage.open(upload.key)
    try:
        with tempfile.TemporaryFile() as staged:
            for chunk in media.stream:
                staged.write(chunk)
            staged.seek(0)
            storage.upload_stream(staged, key, mime, 'private, max-age=0')
    finally:
        media.stream.close()
    return key, mime, int(upload.byte_size)


def register(board_id, user_id, now, data):
    """Turn a finished upload into a Talktrack."""
    video_ref = data.get('referenceId')
    if not isinstance(video_ref, str) or not video_ref:
        raise FacilitationError('referenceId is required.')
    duration = _whole(data.get('durationMs'), 1, MAX_DURATION_MS, 'durationMs')
    key, mime, size = _copy_upload(user_id, video_ref, board_id)
    if not mime.startswith('video/'):
        raise FacilitationError('The recording must be a video.')
    audio_key = None
    audio_ref = data.get('audioReferenceId')
    if isinstance(audio_ref, str) and audio_ref:
        audio_key, audio_mime, _ = _copy_upload(user_id, audio_ref, board_id)
        if not audio_mime.startswith('audio/'):
            raise FacilitationError('The audio track must be audio.')
    row = Talktrack.objects.create(
        id=uuid4(), board_id=board_id, owner_id=user_id, title=_title(data.get('title')), key=key, mime=mime, size=size,
        duration_ms=duration, status='processing' if mime == 'video/webm' else 'ready', audio_key=audio_key,
        created_at=now, updated_at=now)
    return row


def _counts(ids):
    return {row['talktrack_id']: row['n'] for row in
            TalktrackView.objects.filter(talktrack_id__in=ids).values('talktrack_id').annotate(n=Count('id'))}


def listing(board_id, user_id):
    rows = list(Talktrack.objects.filter(board_id=board_id).order_by('-created_at', '-id'))
    ids = [row.id for row in rows]
    counts = _counts(ids)
    mine = dict(TalktrackView.objects.filter(talktrack_id__in=ids, user_id=user_id).values_list('talktrack_id', 'watched_ms'))
    return [to_dict(row, counts.get(row.id, 0), mine.get(row.id, 0)) for row in rows]


def mine(user_id):
    """The signed-in user's own recordings across boards, for the dashboard."""
    from .models import CanvasBoard
    rows = list(Talktrack.objects.filter(owner_id=user_id).order_by('-created_at', '-id')[:200])
    boards = {board_id: (name, project_id) for board_id, name, project_id in
              CanvasBoard.objects.filter(pk__in={row.board_id for row in rows}).values_list('id', 'name', 'project_id')}
    counts = _counts([row.id for row in rows])
    return [{**to_dict(row, counts.get(row.id, 0)), 'boardName': boards.get(row.board_id, ('Board', None))[0],
             'projectId': str(boards[row.board_id][1]) if row.board_id in boards else None} for row in rows]


def _owns_or_manages(row, user_id, level):
    from . import access
    if str(row.owner_id) != str(user_id) and level < access.CO_OWNER:
        raise FacilitationError('FORBIDDEN', 403)


def update(board_id, talktrack_id, user_id, level, now, data):
    """Rename, trim (playback offsets) or request a cut of the middle."""
    with transaction.atomic():
        row = Talktrack.objects.select_for_update().filter(pk=talktrack_id, board_id=board_id).first() \
            if _valid(talktrack_id) else None
        if row is None:
            raise FacilitationError('Talktrack not found.', 404)
        _owns_or_manages(row, user_id, level)
        if 'title' in data:
            row.title = _title(data['title'], row.title)
        if 'trimStartMs' in data or 'trimEndMs' in data:
            start = _whole(data.get('trimStartMs', row.trim_start_ms), 0, row.duration_ms, 'trimStartMs')
            end = _whole(data.get('trimEndMs', row.duration_ms if row.trim_end_ms is None else row.trim_end_ms),
                         0, row.duration_ms, 'trimEndMs')
            if end - start < 1000:
                raise FacilitationError('Keep at least one second of the recording.')
            row.trim_start_ms, row.trim_end_ms = start, None if end >= row.duration_ms else end
        if 'cut' in data:
            if row.status.removeprefix(WORKING) in JOB_STATUSES:
                raise FacilitationError('This recording is still being processed.', 409)
            cut = data['cut']
            if not isinstance(cut, dict):
                raise FacilitationError('cut must have startMs and endMs.')
            start = _whole(cut.get('startMs'), 0, row.duration_ms, 'startMs')
            end = _whole(cut.get('endMs'), 0, row.duration_ms, 'endMs')
            if end - start < 100 or (start == 0 and end >= row.duration_ms) or row.duration_ms - (end - start) < 1000:
                raise FacilitationError('Cut a part of the recording and keep at least one second.')
            row.status, row.cut_start_ms, row.cut_end_ms = 'cutting', start, end
        row.updated_at = now
        row.save()
    return row


def _valid(value):
    from .views import UUID_PATTERN
    return isinstance(value, str) and bool(UUID_PATTERN.fullmatch(value))


def delete(board_id, talktrack_id, user_id, level):
    from apps.media.storage import get_storage
    with transaction.atomic():
        row = Talktrack.objects.select_for_update().filter(pk=talktrack_id, board_id=board_id).first() \
            if _valid(talktrack_id) else None
        if row is None:
            raise FacilitationError('Talktrack not found.', 404)
        _owns_or_manages(row, user_id, level)
        keys = [row.key] + ([row.audio_key] if row.audio_key else [])
        row.delete()
    storage = get_storage()
    for key in keys:
        try:
            storage.delete(key)
        except Exception:
            pass


def record_view(board_id, talktrack_id, user_id, now, data):
    """Note that `user_id` watched: the furthest they got and whether they reached the end."""
    row = _row(board_id, talktrack_id)
    watched = _whole(data.get('watchedMs', 0), 0, MAX_DURATION_MS, 'watchedMs')
    watched = min(watched, row.duration_ms)
    completed = data.get('completed') is True
    with transaction.atomic():
        view, created = TalktrackView.objects.select_for_update().get_or_create(
            talktrack=row, user_id=user_id, defaults={'first_at': now, 'last_at': now, 'watched_ms': watched, 'completed': completed})
        if not created:
            view.watched_ms = max(view.watched_ms, watched)
            view.completed = view.completed or completed
            view.last_at = now
            view.save()
    return {'watchedMs': view.watched_ms, 'completed': view.completed}


def viewers(board_id, talktrack_id):
    """Who watched, most recent first. Totals are SQL aggregates over every viewer."""
    from apps.authentication.models import User
    row = _row(board_id, talktrack_id)
    views = list(TalktrackView.objects.filter(talktrack=row).order_by('-last_at', 'id'))
    people = {user.id: user for user in User.objects.filter(id__in=[view.user_id for view in views])}
    totals = TalktrackView.objects.filter(talktrack=row).aggregate(
        viewers=Count('id'), completed=Count('id', filter=Q(completed=True)), watched=Sum('watched_ms'))
    return {'viewers': [{'userId': str(view.user_id), 'name': getattr(people.get(view.user_id), 'name', 'Someone'),
                         'firstAt': view.first_at, 'lastAt': view.last_at, 'watchedMs': view.watched_ms,
                         'completed': view.completed} for view in views],
            'totals': {'viewers': totals['viewers'], 'completed': totals['completed'], 'watchedMs': totals['watched'] or 0}}


def _moment_dict(moment, names):
    return {'id': str(moment.id), 'userId': str(moment.user_id), 'name': names.get(moment.user_id, 'Someone'),
            'atMs': moment.at_ms, 'emoji': moment.emoji, 'text': moment.text, 'createdAt': moment.created_at}


def moments(board_id, talktrack_id):
    from apps.authentication.models import User
    row = _row(board_id, talktrack_id)
    items = list(TalktrackMoment.objects.filter(talktrack=row).order_by('at_ms', 'created_at', 'id')[:2000])
    names = dict(User.objects.filter(id__in={item.user_id for item in items}).values_list('id', 'name'))
    return [_moment_dict(item, names) for item in items]


def add_moment(board_id, talktrack_id, user_id, now, data):
    """An emoji reaction or a comment at a point of the timeline."""
    from apps.authentication.models import User
    row = _row(board_id, talktrack_id)
    at = _whole(data.get('atMs'), 0, row.duration_ms, 'atMs')
    emoji = data.get('emoji') if isinstance(data.get('emoji'), str) else ''
    text = data.get('text').strip()[:COMMENT_LIMIT] if isinstance(data.get('text'), str) else ''
    if bool(emoji) == bool(text):
        raise FacilitationError('Send either an emoji or a comment.')
    if emoji and emoji not in EMOJIS:
        raise FacilitationError('Unknown reaction.')
    if TalktrackMoment.objects.filter(talktrack=row).count() >= 2000:
        raise FacilitationError('This recording has reached its reaction limit.', 429)
    moment = TalktrackMoment.objects.create(id=uuid4(), talktrack=row, user_id=user_id, at_ms=at, emoji=emoji, text=text, created_at=now)
    names = dict(User.objects.filter(id=user_id).values_list('id', 'name'))
    return _moment_dict(moment, names)


def delete_moment(board_id, talktrack_id, moment_id, user_id, level):
    from . import access
    row = _row(board_id, talktrack_id)
    moment = TalktrackMoment.objects.filter(pk=moment_id, talktrack=row).first() if _valid(moment_id) else None
    if moment is None:
        raise FacilitationError('Reaction not found.', 404)
    if str(moment.user_id) != str(user_id) and level < access.CO_OWNER and str(row.owner_id) != str(user_id):
        raise FacilitationError('FORBIDDEN', 403)
    moment.delete()


# ---- transcript, chapters ----

SEGMENT = re.compile(r'^\[(\d+):(\d{2})(?:\.(\d{1,3}))?\s*-\s*(\d+):(\d{2})(?:\.(\d{1,3}))?\]\s*(?:([^:]{1,40}):\s*)?(.*)$')


def _ms(minutes, seconds, fraction):
    return (int(minutes) * 60 + int(seconds)) * 1000 + int((fraction or '0').ljust(3, '0'))


def parse_transcript(text):
    """The provider's `[MM:SS.mmm - MM:SS.mmm] Speaker: words` lines as segments; other lines are kept as text."""
    segments = []
    for line in str(text).splitlines():
        line = line.strip()
        if not line:
            continue
        match = SEGMENT.match(line)
        if match:
            a, b, c, d, e, f, speaker, words = match.groups()
            segments.append({'startMs': _ms(a, b, c), 'endMs': _ms(d, e, f), 'speaker': (speaker or '').strip(), 'text': words.strip()})
        elif segments:
            segments[-1]['text'] = (segments[-1]['text'] + ' ' + line).strip()
        else:
            segments.append({'startMs': 0, 'endMs': 0, 'speaker': '', 'text': line})
    return segments


def chapters_from(segments, window=CHAPTER_WINDOW_MS):
    """Chapters without an extra AI call: a new chapter every `window`, titled by what is said first in it."""
    chapters, start = [], None
    for segment in segments:
        if segment['text'] and (start is None or segment['startMs'] - start >= window):
            title = re.sub(r'\s+', ' ', segment['text'])
            title = title if len(title) <= 60 else title[:57].rstrip() + '...'
            chapters.append({'startMs': segment['startMs'], 'title': title})
            start = segment['startMs']
    return chapters


def make_transcript(board_id, talktrack_id, user_id, now):
    """Transcribe the recording's audio track once, when the person asks. Uses the audio transcription path
    (paid guard, generation worker, Gemini) exactly like `/api/audio/transcribe`."""
    from apps.generation.services import audio_submission
    from apps.generation.services.audio_submission import AUDIO_READY
    from apps.media.audio_inputs import InvalidAudioType, capture_audio_input
    from apps.media.audio_wait import AudioFailed, AudioResultPending, wait_for_audio
    from apps.media.storage import MediaTooLargeError, get_storage
    row = _row(board_id, talktrack_id)
    if row.transcript is not None:
        return row
    if not row.audio_key:
        raise FacilitationError('This recording has no separate audio track to transcribe.', 409)
    if not transcription_available():
        raise FacilitationError('Transcription is not configured.', 503)
    model = getattr(settings, 'AUDIO_TRANSCRIPTION_MODEL', 'gemini-2.5-flash')
    identifier, started = uuid4(), int(__import__('time').time() * 1000)
    ref = '/api/media/' + row.audio_key
    try:
        snapshot = capture_audio_input(get_storage(), ref, identifier, model=model, name=row.title)
        intent = audio_submission.persist_audio_intent(dict(
            id=identifier, kind='audio', status='queued', prompt='', model=f'Gemini ({model})', aspect_ratio='audio',
            reference_audios=[ref], project_id=None, user_id=user_id, cost_cents=0, cost_basis='estimated',
            created_at=started, updated_at=started, provider_status=AUDIO_READY, submission_input=snapshot))
        saved = wait_for_audio(intent)
    except MediaTooLargeError:
        raise FacilitationError('The audio track is larger than the 15 MB transcription limit.', 413)
    except InvalidAudioType:
        raise FacilitationError('The audio track type cannot be transcribed.', 400)
    except AudioResultPending as error:
        raise FacilitationError(str(error), 504)
    except AudioFailed as error:
        raise FacilitationError(str(error), 429 if error.busy else 502)
    segments = parse_transcript(saved.prompt)
    Talktrack.objects.filter(pk=row.id).update(transcript=segments, chapters=chapters_from(segments), updated_at=now)
    return Talktrack.objects.get(pk=row.id)


# ---- ffmpeg jobs ----

def _ffmpeg(arguments, timeout=1800):
    binary = getattr(settings, 'FFMPEG_BINARY', 'ffmpeg')
    return subprocess.run([binary, '-nostdin', '-hide_banner', '-y', *arguments], capture_output=True, timeout=timeout, check=True)


def _has_audio(path):
    binary = getattr(settings, 'FFMPEG_BINARY', 'ffmpeg')
    probe = subprocess.run([binary, '-nostdin', '-hide_banner', '-i', str(path)], capture_output=True, timeout=60)
    return b'Audio:' in probe.stderr


def cut_arguments(source, target, mime, start_ms, end_ms, duration_ms, audio):
    """ffmpeg arguments that keep [0, start) and [end, duration) and join them."""
    parts = []
    if start_ms > 0:
        parts.append((0, start_ms))
    if end_ms < duration_ms:
        parts.append((end_ms, duration_ms))
    filters = []
    for index, (a, b) in enumerate(parts):
        filters.append(f'[0:v]trim=start={a / 1000}:end={b / 1000},setpts=PTS-STARTPTS[v{index}]')
        if audio:
            filters.append(f'[0:a]atrim=start={a / 1000}:end={b / 1000},asetpts=PTS-STARTPTS[a{index}]')
    inputs = ''.join(f'[v{i}]' + (f'[a{i}]' if audio else '') for i in range(len(parts)))
    filters.append(f'{inputs}concat=n={len(parts)}:v=1:a={1 if audio else 0}[v]' + ('[a]' if audio else ''))
    maps = ['-map', '[v]'] + (['-map', '[a]'] if audio else [])
    if mime == 'video/webm':
        codecs = ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '2M']
        codecs += ['-c:a', 'libopus'] if audio else []
    else:
        codecs = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
        codecs += ['-c:a', 'aac'] if audio else []
    return ['-i', str(source), '-filter_complex', ';'.join(filters), *maps, *codecs, str(target)]


def _map_offset(value, start, end):
    """A file offset after the [start, end) cut."""
    if value <= start:
        return value
    if value >= end:
        return value - (end - start)
    return start


def _download(storage, key, path):
    media = storage.open(key)
    try:
        with open(path, 'wb') as out:
            for chunk in media.stream:
                out.write(chunk)
    finally:
        media.stream.close()


def _store(storage, path, key, mime):
    with open(path, 'rb') as handle:
        storage.upload_stream(handle, key, mime, 'private, max-age=0')


def _process(row, now):
    """Run one job for `row`; returns the fields to write back."""
    from apps.media.storage import get_storage
    storage = get_storage()
    extension = 'webm' if row.mime == 'video/webm' else 'mp4'
    with tempfile.TemporaryDirectory(prefix='veevee-talktrack-') as directory:
        source, target = Path(directory) / f'in.{extension}', Path(directory) / f'out.{extension}'
        _download(storage, row.key, source)
        if row.status == 'processing':
            # A MediaRecorder file has no duration or seek index: a stream copy writes both.
            _ffmpeg(['-i', str(source), '-c', 'copy', str(target)])
            duration = row.duration_ms
            fields = {}
        else:
            start, end = row.cut_start_ms, row.cut_end_ms
            _ffmpeg(cut_arguments(source, target, row.mime, start, end, row.duration_ms, _has_audio(source)))
            duration = row.duration_ms - (end - start)
            trim_start = _map_offset(row.trim_start_ms, start, end)
            trim_end = None if row.trim_end_ms is None else _map_offset(row.trim_end_ms, start, end)
            fields = {'trim_start_ms': trim_start, 'trim_end_ms': trim_end if trim_end is not None and trim_end < duration else None,
                      'cut_start_ms': None, 'cut_end_ms': None, 'transcript': None, 'chapters': None, 'summary': None}
        key = f'talktrack/{row.board_id}/{uuid4()}.{extension}'
        _store(storage, target, key, row.mime)
        size = target.stat().st_size
    return {'key': key, 'size': size, 'duration_ms': duration, 'status': 'ready', 'updated_at': now, **fields}


def process_jobs(limit=2):
    """Scheduler handler: finish up to `limit` waiting remux and cut jobs. A failed job leaves the original
    recording in place and is marked `failed` so it can be tried again."""
    import time
    from apps.media.storage import get_storage
    done = failed = 0
    stale = int(time.time() * 1000) - STALE_JOB_MS
    for row in Talktrack.objects.filter(status__startswith=WORKING, updated_at__lt=stale):
        # A worker that died mid-job: queue it again.
        Talktrack.objects.filter(pk=row.id, status=row.status).update(status=row.status.removeprefix(WORKING))
    for _ in range(limit):
        with transaction.atomic():
            row = Talktrack.objects.select_for_update(skip_locked=True).filter(status__in=JOB_STATUSES).order_by('updated_at').first()
            if row is None:
                break
            Talktrack.objects.filter(pk=row.id).update(status=WORKING + row.status, updated_at=int(time.time() * 1000))
        now = int(time.time() * 1000)
        try:
            row_for_job = Talktrack.objects.get(pk=row.id)
            row_for_job.status = row.status
            fields = _process(row_for_job, now)
        except Exception:
            Talktrack.objects.filter(pk=row.id).update(status='failed', cut_start_ms=None, cut_end_ms=None, updated_at=now)
            failed += 1
            continue
        Talktrack.objects.filter(pk=row.id).update(**fields)
        try:
            get_storage().delete(row.key)
        except Exception:
            pass
        done += 1
    return {'done': done, 'failed': failed}
