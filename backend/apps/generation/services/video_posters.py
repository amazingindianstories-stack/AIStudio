"""First-frame posters for finished video generations.

The master is never touched: ``apps.media.posters`` reads its first frame in place and writes a separate 512 px WebP
under ``thumbs/poster/<key>.webp``. A library card paints that image instead of mounting a ``<video>`` on the master.
"""
import logging
from urllib.parse import quote

from django.conf import settings

from apps.media import posters
from apps.media.keys import media_key_from_ref
from apps.media.storage import get_storage

logger = logging.getLogger('veevee.generation')


def poster_ref(url, storage=None, *, gate=None):
    """The ``/api/media/`` reference of a master's poster, made now if missing; None when it cannot be had. Never raises."""
    try:
        key = media_key_from_ref(url, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
        if not key or not posters.is_video_key(key):
            return None
        options = {'gate': gate} if gate is not None else {}
        made = posters.bounded_poster(storage or get_storage(), key, frame=posters.first_frame, wait=posters.DEADLINE_SECONDS, **options)
        return '/api/media/' + quote(made[0], safe='/') if made else None
    except Exception as error:
        logger.warning('video_poster_failed error=%s', type(error).__name__)
        return None
