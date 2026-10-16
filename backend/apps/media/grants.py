"""Node-compatible object-scoped HMAC grants (expiry is milliseconds)."""
import base64
import hashlib
import hmac
import math
import time
from urllib.parse import quote
from django.conf import settings
from .keys import validate_key, InvalidMediaKey, is_export_key


def _encode(value):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


def _signature(payload):
    return _encode(hmac.new(settings.AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).digest())


def _upload_session(key):
    import re
    while match := re.fullmatch(r'thumbs/[0-9]+/(.+)\.webp', key):
        key = match[1]
    if not key.startswith('uploads/'):
        return None
    from .models import UploadSession
    return UploadSession.objects.filter(key=key).first()


def authorize_upload_read(key, actor_id):
    if is_export_key(key):
        raise ValueError('Export archives require their owned download route.')
    row = _upload_session(key)
    if not row:
        return None
    # Shared studio: every READY upload is readable by any authenticated actor.
    if not row.finalized_at or row.state != 'ready':
        raise ValueError('Uploaded reference is not authorized and ready.')
    return row


def authorize_owned_upload_read(key, actor_id):
    """Owner-only check for personal flows such as ZIP exports.

    Shared READY reads do not extend to selecting another actor's private
    upload into an export; published catalog material stays shareable.
    """
    row = authorize_upload_read(key, actor_id)
    if row is None:
        return None
    if not actor_id:
        raise ValueError('Uploaded reference is not authorized and ready.')
    if str(row.actor_id) != str(actor_id):
        from apps.assets.models import Asset, ManagedPortraitAsset, PortraitAsset
        canonical = '/api/media/'+row.key
        published = (Asset.objects.filter(images__contains=[canonical]).exists()
            or PortraitAsset.objects.filter(image_url=canonical).exists()
            # The shared Portrait Gallery: other artists' portraits (and their thumbnails) are visible to everyone.
            or ManagedPortraitAsset.objects.filter(source_key=row.key, hidden_at__isnull=True).exclude(status__in=('DELETING', 'DELETED', 'FAILED')).exists())
        if not published:
            raise ValueError('Uploaded reference is private to its uploader.')
    return row


def sign_media_grant(key, ttl_seconds=900, *, now=None, actor_id=None):
    validate_key(key)
    row = authorize_upload_read(key, actor_id)
    expires = int((time.time() * 1000 if now is None else now) + ttl_seconds * 1000)
    payload = f'{_encode(key.encode())}.{expires}'
    if row:
        payload += '.'+str(actor_id)
    return f'{payload}.{_signature(payload)}'


def verify_media_grant(token, *, now=None):
    try:
        parts = token.split('.')
        if len(parts) not in (3, 4):
            return None
        encoded, expiry, signature = parts[0], parts[1], parts[-1]
        actor_id = parts[2] if len(parts) == 4 else None
        expected = _signature('.'.join(parts[:-1]))
        if not hmac.compare_digest(signature, expected):
            return None
        expires = float(expiry)
        if not math.isfinite(expires) or (time.time()*1000 if now is None else now) > expires:
            return None
        key = base64.b64decode(encoded + '=' * (-len(encoded) % 4), altchars=b'-_', validate=True).decode()
        key = validate_key(key)
        authorize_upload_read(key, actor_id)
        return key
    except (ValueError, TypeError, AttributeError, UnicodeError, InvalidMediaKey):
        return None


def media_grant_url(key, ttl_seconds=900, *, actor_id=None):
    origin = getattr(settings, 'PUBLIC_APP_URL', '').rstrip('/')
    if not origin:
        raise ValueError('PUBLIC_APP_URL is required for provider media grants.')
    return f'{origin}/api/media-grant?t={quote(sign_media_grant(key, ttl_seconds, actor_id=actor_id), safe="")}'
