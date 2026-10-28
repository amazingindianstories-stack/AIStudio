"""Short-lived links to a generation's stored file and its derivatives, with the time they expire.

``original`` is the native master as a 5-minute signed attachment with the canonical filename (a signed media grant
where storage cannot sign attachments). ``preview``, ``thumbnail`` and ``poster`` are signed reads reported as 14
minutes, like /api/media-resolve. Image previews and thumbnails are the 1280 and 512 px WebP derivatives; a video
previews as its master and its thumbnail is the poster frame. A derivative that cannot be made is null (a missing
image preview falls back to the master); the master is never touched. With a reply deadline (``until``, monotonic
seconds) a derivative is made only while it can finish ``MAKE_RESERVE_SECONDS`` before the deadline; later, only one
that already exists is used.
"""
import time
from concurrent.futures import ThreadPoolExecutor

from django.conf import settings
from django.db import close_old_connections

from apps.media.derivatives import READ_DEADLINE_SECONDS, bounded_derivative
from apps.media.images import is_thumbnailable
from apps.media.keys import media_key_from_ref
from apps.media.posters import DEADLINE_SECONDS as POSTER_SECONDS, bounded_poster, is_video_key
from apps.media.storage import MIME, attachment_disposition, get_storage
from apps.media.views import authorize_media_key

VARIANTS = ('original', 'preview', 'thumbnail', 'poster')
ORIGINAL_SECONDS = 300
READ_SECONDS = 900
READ_REPORTED_MS = (READ_SECONDS - 60) * 1000      # signed reads may come from a 45 s per-process cache
PREVIEW_MAX_BYTES = 2 * 1024 * 1024
THREADS = 8
MAKE_RESERVE_SECONDS = 5           # left after making derivatives, for measuring, the inline preview and the reply
MIN_MAKE_SECONDS = 4               # with less time than this, make nothing


def media_key(item):
    """The stored master's key for a public generation item, or None when it has none or it is hidden."""
    try:
        key = media_key_from_ref(item.get('url'), getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
        return authorize_media_key(key) if key else None
    except Exception:
        return None


def _read_url(storage, key):
    url = storage.browser_url(key) or storage.signed_read_url(key, READ_SECONDS)
    return url, int(time.time() * 1000) + READ_REPORTED_MS


def _original_url(storage, key, filename):
    url = storage.signed_download_url(key, filename, attachment_disposition(filename)) or storage.signed_read_url(key, ORIGINAL_SECONDS)
    return url, int(time.time() * 1000) + ORIGINAL_SECONDS * 1000


def make_seconds(until, ceiling):
    """How long making one derivative may take: ``ceiling`` without a deadline, 0 (existing ones only) when it is near."""
    if until is None:
        return ceiling
    left = until - MAKE_RESERVE_SECONDS - time.monotonic()
    return min(ceiling, left) if left >= MIN_MAKE_SECONDS else 0


def derivative(storage, key, variant, *, until=None):
    """``(derivative_key, fresh_bytes_or_None)`` for preview/thumbnail/poster, made on first use; None when unavailable."""
    if is_video_key(key):
        return (bounded_poster(storage, key, seconds=make_seconds(until, POSTER_SECONDS))
                if variant in ('thumbnail', 'poster') else None)
    if variant == 'poster' or not is_thumbnailable(key):
        return None
    target, fresh = bounded_derivative(storage, key, 1280 if variant == 'preview' else 512,
                                       seconds=make_seconds(until, READ_DEADLINE_SECONDS))
    return (target, fresh) if target != key else None


def stored_file(storage, key, kind, *, measure):
    """Bytes (and image dimensions from the header only) when ``measure``; nulls otherwise. Never decodes a master."""
    found = {'bytes': None, 'width': None, 'height': None}
    if not measure:
        return found
    try:
        media = storage.open(key)
    except Exception:
        return found
    try:
        found['bytes'] = media.content_length
        if kind == 'image':
            from apps.generation.image_limits import dimensions
            found['width'], found['height'] = dimensions(media.stream) or (None, None)
    except Exception:
        pass
    finally:
        media.stream.close()
    return found


def resolve(item, variants, *, measure=False, storage=None, key=None, until=None):
    """The Output links for one generation item: ``{'urls', 'urlsExpireAt', 'bytes', 'width', 'height'}`` or None."""
    key = key or media_key(item)
    if key is None:
        return None
    storage = storage or get_storage()
    urls, expiries = {}, []
    filename = item.get('filename') or key.rsplit('/', 1)[-1]
    for variant in variants:
        try:
            if variant == 'original':
                url, expires = _original_url(storage, key, filename)
            elif variant == 'preview' and (is_video_key(key) or item.get('kind') == 'audio'):
                url, expires = _read_url(storage, key)
            else:
                made = derivative(storage, key, variant, until=until)
                if made is None and variant == 'preview':
                    made = (key, None)
                url, expires = _read_url(storage, made[0]) if made else (None, None)
        except Exception:
            url, expires = None, None
        urls[variant] = url
        if url:
            expiries.append(expires)
    return {'urls': urls, 'urlsExpireAt': min(expiries) if expiries else None,
            **stored_file(storage, key, item.get('kind'), measure=measure)}


def resolve_many(items, variants, *, measure=False, until=None):
    """``resolve`` for a batch, eight storage calls at a time; results in the order of ``items``.

    Keys are authorized here, on the caller's database thread; the pool only talks to storage."""
    storage = get_storage()
    keys = [media_key(item) for item in items]

    def one(pair):
        item, key = pair
        try:
            return resolve(item, variants, measure=measure, storage=storage, key=key, until=until) if key else None
        finally:
            close_old_connections()
    if len(items) <= 1:
        return [resolve(item, variants, measure=measure, storage=storage, key=key, until=until) if key else None
                for item, key in zip(items, keys)]
    with ThreadPoolExecutor(max_workers=THREADS, thread_name_prefix='mcp-links') as pool:
        return list(pool.map(one, zip(items, keys)))


def preview_image(item, *, until=None):
    """``(webp_bytes, 'image/webp')`` for the inline preview: the 512 px thumbnail or the video poster; else None."""
    key = media_key(item)
    if key is None:
        return None
    storage = get_storage()
    made = derivative(storage, key, 'thumbnail', until=until)
    if made is None:
        return None
    target, fresh = made
    if fresh is None:
        try:
            media = storage.open(target)
        except Exception:
            return None
        try:
            if media.content_length > PREVIEW_MAX_BYTES:
                return None
            fresh = b''.join(media.stream)
        except Exception:
            return None
        finally:
            media.stream.close()
    return fresh, 'image/webp'


def mime_type(item, filename):
    extension = (filename or '').rsplit('.', 1)[-1].lower()
    return MIME.get(extension) or {'image': 'image/png', 'video': 'video/mp4', 'audio': 'audio/mpeg'}.get(item.get('kind'),
                                                                                                         'application/octet-stream')
