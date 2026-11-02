"""Which reference videos are portraits: a face on a few sampled frames, for clips BytePlus can register as a Video asset.

The video twin of ``managed_pool.scan_reference``. A clip with a face, inside the BytePlus video limits (``video_limits``),
is registered like a Gallery video portrait and sent as ``asset://``. A clip without a face, outside the limits, or whose
size cannot be hashed keeps going as a plain URL. Results are cached by content hash in ``ReferenceFaceScan``, so a clip is
read and scanned once, whoever adds it. The scan fails closed like the image one: a frame the detector cannot read counts as a face.
"""
import collections
import hashlib
import logging
import subprocess
import tempfile
import threading
from pathlib import Path

from django.conf import settings

from . import managed_pool, video_limits
from .face_detect import DETECTOR_VERSION
from .models import ManagedPortraitAsset, ReferenceFaceScan

logger = logging.getLogger('veevee.portraits')
VIDEO_DETECTOR_VERSION = DETECTOR_VERSION + '+video-v1'
SAMPLES = (0.1, 0.3, 0.5, 0.7, 0.85)       # where in the clip the frames are taken, as fractions of its duration
FRAME_LONG_SIDE = 960
FRAME_BYTES = 32 * 1024 * 1024
_HASHES = collections.OrderedDict()        # storage key -> content sha, for clips hashed by reading them
_HASHES_MAX = 256
_HASHES_LOCK = threading.Lock()


def reference_sha(storage, key):
    """Content hash of the stored clip ``key``, or None when it is too large to be a portrait or cannot be read.
    Reuses a hash the system already holds (a Gallery row, a finalized upload) and otherwise streams the object once."""
    row = ManagedPortraitAsset.objects.filter(source_key=key, media_kind='video').order_by('-created_at').values_list('content_sha256', flat=True).first()
    if row:
        return row
    from apps.media.models import UploadSession
    uploaded = UploadSession.objects.filter(key=key, state='ready').exclude(sha256='').values_list('sha256', 'byte_size').first()
    if uploaded:
        return uploaded[0] if uploaded[1] <= video_limits.MAX_BYTES else None
    with _HASHES_LOCK:
        known = _HASHES.get(key)
    if known:
        return known
    try:
        media = storage.open(key)
    except Exception:
        return None
    try:
        if media.content_length > video_limits.MAX_BYTES:
            return None
        digest = hashlib.sha256()
        for chunk in media.stream:
            digest.update(chunk)
    except Exception:
        return None
    finally:
        try:
            media.stream.close()
        except Exception:
            pass
    with _HASHES_LOCK:
        _HASHES[key] = digest.hexdigest()
        while len(_HASHES) > _HASHES_MAX:
            _HASHES.popitem(last=False)
    return digest.hexdigest()


def _record(sha, has_face, faces=0, error=None):
    ReferenceFaceScan.objects.update_or_create(pk=sha, defaults={'has_face': has_face, 'faces': faces, 'detector_version': VIDEO_DETECTOR_VERSION,
                                                                  'error': error, 'scanned_at': managed_pool.now_ms()})


def _frame(source, protocols, seconds, timeout):
    """PNG bytes of the frame at ``seconds``, at most FRAME_LONG_SIDE px, without decoding the clip up to it."""
    binary = getattr(settings, 'FFMPEG_BINARY', 'ffmpeg')
    scale = f"scale='min({FRAME_LONG_SIDE},iw)':'min({FRAME_LONG_SIDE},ih)':force_original_aspect_ratio=decrease"
    with tempfile.TemporaryDirectory(prefix='veevee-face-') as directory:
        output = Path(directory) / 'frame.png'
        subprocess.run([binary, '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', protocols, '-ss', f'{seconds:.2f}', '-i', source,
                        '-map', '0:v:0', '-frames:v', '1', '-vf', scale, '-y', str(output)], capture_output=True, timeout=timeout, check=True)
        data = output.read_bytes()
    if not 0 < len(data) <= FRAME_BYTES:
        raise ValueError('frame size')
    return data


def _scan_frames(storage, key, duration):
    """(has_face, faces, error) over the sampled frames, or None when ffmpeg is busy (try again later)."""
    from apps.media import posters
    from . import face_detect
    if not posters._GATE.acquire(timeout=posters.DEADLINE_SECONDS):
        return None
    try:
        source, protocols = posters._source(storage, key)
        if source is None:
            return True, 0, 'SourceUnavailable'
        for fraction in SAMPLES:
            try:
                data = _frame(source, protocols, duration * fraction, posters.DEADLINE_SECONDS)
            except Exception as error:      # a frame that cannot be read cannot be shown to be free of faces
                return True, 0, type(error).__name__
            found = face_detect.scan(data)
            if found['has_face']:
                return True, found['faces'], found['error']
        return False, 0, None
    finally:
        posters._GATE.release()


def is_portrait(storage, key, sha):
    """True when this reference clip should be registered as a portrait asset, False when it goes as a URL, None when
    the answer is not known yet (the frame extractor is busy)."""
    cached = ReferenceFaceScan.objects.filter(pk=sha).first()
    if cached and cached.forced == managed_pool.REFUSED:
        return False      # BytePlus refused the asset: the clip goes as it did before
    live = ManagedPortraitAsset.objects.filter(content_sha256=sha).exclude(status__in=('DELETED', 'FAILED')).values_list('source_key', flat=True).first()
    if live:              # already (being) registered, or a Gallery upload waiting its turn: share it, no scan needed
        return _with_poster(storage, live)
    if cached and cached.detector_version == VIDEO_DETECTOR_VERSION and not cached.error:
        return _with_poster(storage, key) if cached.has_face else False
    found = _scan(storage, key, sha)
    return _with_poster(storage, key) if found else found


def _with_poster(storage, key):
    """True, once the Gallery card of the clip registered from ``key`` has its picture (best effort: tried again next time)."""
    from apps.media import posters
    posters.bounded_poster(storage, key, video=True, wait=posters.DEADLINE_SECONDS)
    return True


def _scan(storage, key, sha):
    info = video_limits.probe_stored(storage, key)
    if info is None:      # unreadable now (maybe only for now): the clip goes as a URL and is looked at again next time
        logger.info('reference video %s stays a URL: it could not be probed', sha[:12])
        return False
    problem = video_limits.problem(info)
    if problem:
        logger.info('reference video %s stays a URL: %s', sha[:12], problem[0])
        _record(sha, False)
        return False
    scanned = _scan_frames(storage, key, info['seconds'])
    if scanned is None:
        return None
    has_face, faces, error = scanned
    _record(sha, has_face, faces, error)
    if not has_face:
        logger.info('reference video %s stays a URL: no face found', sha[:12])
    return has_face
