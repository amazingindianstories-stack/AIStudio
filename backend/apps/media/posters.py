"""Bounded video poster derivatives: the first frame of a master as a 512 px WebP.

Callers authorize first. The master is never rewritten: ffmpeg reads its first frame in place (a local path, or a
short signed URL read with HTTP ranges) and the poster is written create-only under ``thumbs/poster/<key>.webp``.
One ffmpeg runs per process at a time with a 15 s deadline; a busy gate, a failure or a timeout returns None.
"""
import subprocess
import tempfile
import threading
from pathlib import Path

from django.conf import settings

from .derivatives import DERIVATIVE_CACHE_CONTROL, encode_display
from .keys import is_export_key, validate_key
from .storage import FileSystemAdapter

POSTER_WIDTH = 512
DEADLINE_SECONDS = 15
SOURCE_URL_SECONDS = 120
MAX_FRAME_BYTES = 32 * 1024 * 1024
VIDEO_EXTENSIONS = ('mov', 'mp4', 'webm')
_GATE = threading.BoundedSemaphore(1)


def poster_key(key):
    return f'thumbs/poster/{key}.webp'


def is_video_key(key):
    return isinstance(key, str) and not key.startswith('thumbs/') and key.rsplit('.', 1)[-1].lower() in VIDEO_EXTENSIONS


def _source(storage, key):
    """The ffmpeg input and protocol allowlist: the file itself for local storage, otherwise a short signed read."""
    adapter = storage._read_adapter(key)
    if isinstance(adapter, FileSystemAdapter):
        path = adapter._path(key)
        return (str(path), 'file') if path.is_file() else (None, None)
    url = storage.signed_read_url(key, SOURCE_URL_SECONDS)
    return (url, 'https,tls,tcp') if isinstance(url, str) and url.startswith('https://') else (None, None)


def first_frame(source, protocols, *, timeout=DEADLINE_SECONDS):
    """PNG bytes of the first video frame, read without decoding the rest of the master."""
    binary = getattr(settings, 'FFMPEG_BINARY', 'ffmpeg')
    with tempfile.TemporaryDirectory(prefix='veevee-poster-') as directory:
        output = Path(directory) / 'frame.png'
        subprocess.run([binary, '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', protocols,
                        '-ss', '0', '-i', source, '-map', '0:v:0', '-frames:v', '1', '-y', str(output)],
                       capture_output=True, timeout=timeout, check=True)
        data = output.read_bytes()
    if not 0 < len(data) <= MAX_FRAME_BYTES:
        raise ValueError('Poster frame size')
    return data


def bounded_poster(storage, key, *, frame=first_frame, gate=_GATE, seconds=DEADLINE_SECONDS):
    """Return ``(poster_key, fresh_bytes_or_None)`` when a poster exists or was just made, else None; never raises.

    ``seconds`` bounds ffmpeg; at 0 an existing poster is used and none is made."""
    try:
        validate_key(key)
        if not is_video_key(key) or is_export_key(key):
            return None
        target = poster_key(key)
        if storage.exists(target):
            return target, None
    except Exception:
        return None
    if seconds <= 0 or not gate.acquire(blocking=False):
        return None
    try:
        if storage.exists(target):
            return target, None
        source, protocols = _source(storage, key)
        if source is None:
            return None
        fresh = encode_display(frame(source, protocols, timeout=seconds), POSTER_WIDTH)
        put = getattr(storage.primary, 'put_create_only', None)
        if put is None:
            storage.primary.put(target, fresh, 'image/webp', DERIVATIVE_CACHE_CONTROL)
        elif not put(target, fresh, 'image/webp', DERIVATIVE_CACHE_CONTROL):
            return (target, None) if storage.exists(target) else None
        return target, fresh
    except Exception:
        return None
    finally:
        gate.release()
