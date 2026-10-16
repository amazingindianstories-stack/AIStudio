import hashlib
import hmac
import json
import time
import re
import base64
from uuid import uuid4
from django.conf import settings
from django.core.exceptions import ValidationError
from .keys import validate_key

PURPOSES = {
    'image-reference': ('uploads/image-reference', r'image/(jpeg|png|webp|tiff|gif|heic|heif|avif|bmp)$'),
    'audio-reference': ('uploads/audio-reference', r'audio/(mpeg|mp3|wav|x-wav|wave|ogg|webm|mp4|x-m4a|aac|flac)$'),
    'video-reference': ('uploads/video-reference', r'video/(mp4|quicktime|x-m4v|webm)$'),
    'depth-input': ('uploads/depth-input', r'video/(mp4|quicktime|x-m4v|webm)$'),
    'portrait': ('uploads/portrait', r'image/(jpeg|png|webp|tiff|gif|heic|heif|avif|bmp)$'),
    'material': ('uploads/material', r'image/(jpeg|png|webp|tiff|gif|heic|heif|avif|bmp)$'),
    'canvas': ('uploads/canvas', r'image/(jpeg|png|webp|tiff|gif|heic|heif|avif|bmp)$'),
}


def create_upload_presign(user_id, purpose, content_type, sign_upload_url, create_id=uuid4):
    if not user_id:
        return 401, {'error':'Unauthorized.'}
    if not isinstance(purpose, str) or purpose not in PURPOSES:
        return 400, {'error':f'Unknown upload purpose (expected one of: {", ".join(PURPOSES)}).'}
    mime = content_type.strip().lower() if isinstance(content_type, str) else ''
    mime = {'image/jpg':'image/jpeg','image/pjpeg':'image/jpeg','image/x-png':'image/png'}.get(mime,mime)
    prefix, pattern = PURPOSES[purpose]
    if not re.match(pattern, mime):
        return 400, {'error':f'{purpose} does not accept content type "{content_type if isinstance(content_type,str) else ""}".'}
    key = f'{prefix}/{user_id}-{create_id()}'
    try:
        return 200, {'key':key, 'uploadUrl':sign_upload_url(key,mime)}
    except Exception:
        return 500, {'error':'Failed to create an upload URL.'}


def sign_upload(key, content_type):
    validate_key(key)
    payload = base64.urlsafe_b64encode(json.dumps({'key':key,'type':content_type,'exp':int(time.time())+1800},
        separators=(',',':')).encode()).decode().rstrip('=')
    signature = hmac.new(settings.AUTH_SECRET.encode(), ('upload:'+payload).encode(), hashlib.sha256).hexdigest()
    return payload + '.' + signature


def verify_upload(token):
    try:
        payload, signature = token.split('.')
        expected = hmac.new(settings.AUTH_SECRET.encode(), ('upload:'+payload).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature,expected):
            return None
        value = json.loads(base64.urlsafe_b64decode(payload + '='*(-len(payload)%4)))
        if type(value.get('exp')) is not int or value['exp'] < time.time():
            return None
        validate_key(value['key'])
        # depth-output/: the external depth worker's result upload (signed by /api/worker/depth/upload-url).
        if not value['key'].startswith(('uploads/','exports/','depth-output/')) or not isinstance(value['type'],str):
            return None
        return value
    except (ValueError, TypeError, KeyError, AttributeError, UnicodeError):
        return None

# Versioned metadata handshake. The old presign route remains compatibility-only.
from datetime import timedelta
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from .storage import FileSystemAdapter, GCSAdapter, MediaNotFoundError

CHUNK_BYTES = 8 * 1024 * 1024
LIMITS = {'image-reference': 256*1024*1024, 'portrait': 256*1024*1024,
          'material': 256*1024*1024, 'canvas': 256*1024*1024,
          'audio-reference': 512*1024*1024, 'video-reference': 2*1024**3,
          'depth-input': 2*1024**3}


class UploadError(ValueError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def _cipher():
    from cryptography.fernet import Fernet
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(
        ('upload-session:'+settings.AUTH_SECRET).encode()).digest()))


def _session_model():
    from .models import UploadSession
    return UploadSession


def _owned_session(actor_id, session_id, *, locked=False):
    queryset = _session_model().objects
    if locked:
        queryset = queryset.select_for_update()
    row = queryset.filter(id=session_id, actor_id=actor_id).first()
    if not row:
        raise UploadError('UPLOAD_NOT_FOUND', 404)
    if row.state == 'cancelled':
        raise UploadError('UPLOAD_CANCELLED', 410)
    if not row.finalized_at and row.expires_at <= timezone.now():
        raise UploadError('UPLOAD_EXPIRED', 410)
    return row


def _metadata(storage, key):
    if isinstance(storage.primary, GCSAdapter):
        return storage.primary.upload_metadata(key)
    media = storage.primary.open(key)
    try:
        return {'size': media.content_length, 'contentType': media.content_type}
    finally:
        media.stream.close()


def _local_path(storage, row):
    return storage.primary._path(str(row.id), 'upload-parts')


def session_result(row, storage, *, include_uri=False):
    result = {'version': 1, 'uploadId': str(row.id), 'referenceId': str(row.id),
              'key': row.key, 'purpose': row.purpose, 'contentType': row.content_type,
              'filename': row.filename,
              'byteSize': row.byte_size, 'expiresAt': row.expires_at.isoformat(),
              'state': 'ready' if row.finalized_at else row.state, 'chunkBytes': CHUNK_BYTES}
    if row.finalized_at:
        result['ref'] = '/api/media/'+row.key
    elif isinstance(storage.primary, FileSystemAdapter):
        part = _local_path(storage, row)
        result['uploadedBytes'] = part.stat().st_size if part.exists() else 0
        if not part.exists():
            try:
                result['uploadedBytes'] = _metadata(storage, row.key)['size']
            except MediaNotFoundError:
                pass
        if include_uri:
            result['uploadUrl'] = f'/api/uploads/{row.id}/local'
    elif include_uri:
        result['uploadUrl'] = _cipher().decrypt(row.session_uri.encode()).decode()
    return result


def initialize_upload(actor_id, body, storage, *, origin=None):
    from apps.authentication.models import User
    purpose, mime, size = body.get('purpose'), body.get('contentType'), body.get('byteSize')
    if not isinstance(purpose, str) or purpose not in PURPOSES or not isinstance(mime, str):
        raise UploadError('INVALID_UPLOAD_PURPOSE_OR_TYPE')
    mime = mime.strip().lower()
    mime = {'image/jpg':'image/jpeg', 'image/pjpeg':'image/jpeg', 'image/x-png':'image/png'}.get(mime, mime)
    if not re.fullmatch(PURPOSES[purpose][1], mime):
        raise UploadError('INVALID_UPLOAD_CONTENT_TYPE')
    if type(size) is not int or size <= 0 or size > LIMITS[purpose]:
        raise UploadError('UPLOAD_TOO_LARGE_OR_EMPTY', 413)
    filename = body.get('filename', '')
    checksum = body.get('sha256') or ''
    request_key = body.get('requestKey', '')
    if (not isinstance(filename, str) or len(filename) > 255 or any(ord(c) < 32 for c in filename)
        or not isinstance(checksum, str) or (checksum and not re.fullmatch('[0-9a-f]{64}', checksum))
        or not isinstance(request_key, str) or len(request_key) > 128):
        raise UploadError('INVALID_UPLOAD_METADATA')
    if not isinstance(storage.primary, (GCSAdapter, FileSystemAdapter)):
        raise UploadError('RESUMABLE_STORAGE_UNAVAILABLE', 503)
    with transaction.atomic():
        # Serializes quota and idempotency admission for this actor only.
        User.objects.select_for_update().get(id=actor_id)
        if request_key:
            existing = _session_model().objects.filter(actor_id=actor_id, request_key=request_key).first()
            if existing:
                if (existing.purpose, existing.content_type, existing.byte_size, existing.filename,
                    existing.sha256 or '') != (purpose, mime, size, filename, checksum):
                    # Once finalized the actual checksum replaces an omitted checksum.
                    if not (existing.finalized_at and not checksum and
                            (existing.purpose, existing.content_type, existing.byte_size, existing.filename)
                            == (purpose, mime, size, filename)):
                        raise UploadError('UPLOAD_IDEMPOTENCY_CONFLICT', 409)
                existing = _owned_session(actor_id, existing.id)
                return session_result(existing, storage, include_uri=True)
        active = _session_model().objects.filter(actor_id=actor_id, finalized_at__isnull=True,
                    state='uploading', expires_at__gt=timezone.now())
        if active.count() >= getattr(settings, 'VEEVEE_UPLOAD_MAX_INFLIGHT', 64):
            raise UploadError('UPLOAD_INFLIGHT_LIMIT', 429)
        if (active.aggregate(total=Sum('byte_size'))['total'] or 0)+size > getattr(
                settings, 'VEEVEE_UPLOAD_INFLIGHT_BYTES', 8*1024**3):
            raise UploadError('UPLOAD_QUOTA_EXCEEDED', 429)
        identifier = uuid4()
        row = _session_model()(id=identifier, actor_id=actor_id,
            key=f'{PURPOSES[purpose][0]}/{actor_id}-{identifier}', purpose=purpose,
            content_type=mime, byte_size=size, filename=filename, sha256=checksum,
            request_key=request_key, expires_at=timezone.now()+timedelta(hours=24), state='uploading')
        if isinstance(storage.primary, GCSAdapter):
            uri = storage.primary.begin_reference_upload(row.key, mime, size, origin)
            from .storage import validate_gcs_session_uri
            validate_gcs_session_uri(uri)
            row.session_uri = _cipher().encrypt(uri.encode()).decode()
        row.save(force_insert=True)
        return session_result(row, storage, include_uri=True)


def upload_status(actor_id, session_id, storage):
    row = _owned_session(actor_id, session_id)
    return session_result(row, storage, include_uri=True)


def _sniff(data, mime):
    """Container signatures, not client filename/MIME, determine acceptance."""
    if mime == 'image/png': return data.startswith(b'\x89PNG\r\n\x1a\n')
    if mime == 'image/jpeg': return data.startswith(b'\xff\xd8\xff')
    if mime == 'image/gif': return data.startswith((b'GIF87a', b'GIF89a'))
    if mime == 'image/webp': return data[:4] == b'RIFF' and data[8:12] == b'WEBP'
    if mime == 'image/tiff': return data.startswith((b'II*\x00', b'MM\x00*'))
    if mime == 'image/bmp': return data.startswith(b'BM')
    if mime in ('image/heic', 'image/heif', 'image/avif'):
        brands = data[8:128] if data[4:8] == b'ftyp' else b''
        return any(brand in brands for brand in ((b'avif', b'avis') if mime == 'image/avif'
                   else (b'heic', b'heix', b'hevc', b'hevx', b'mif1', b'msf1')))
    if mime in ('audio/wav', 'audio/x-wav', 'audio/wave'):
        return data[:4] in (b'RIFF', b'RF64') and data[8:12] == b'WAVE'
    if mime in ('audio/ogg',): return data.startswith(b'OggS')
    if mime == 'audio/flac': return data.startswith(b'fLaC')
    if mime in ('audio/mpeg', 'audio/mp3'):
        return data.startswith(b'ID3') or len(data) > 1 and data[0] == 255 and data[1] & 224 == 224
    if mime == 'audio/aac': return len(data) > 1 and data[0] == 255 and data[1] & 246 == 240
    if mime in ('video/webm', 'audio/webm'): return data.startswith(b'\x1aE\xdf\xa3')
    if mime in ('video/mp4', 'video/quicktime', 'video/x-m4v', 'audio/mp4', 'audio/x-m4a'):
        return data[4:8] in (b'ftyp', b'wide', b'moov', b'mdat')
    return False


def finalize_upload(actor_id, session_id, storage):
    with transaction.atomic():
        row = _owned_session(actor_id, session_id, locked=True)
        if row.finalized_at:
            return session_result(row, storage)
        try:
            metadata = _metadata(storage, row.key)
        except MediaNotFoundError:
            raise UploadError('UPLOAD_INCOMPLETE', 409)
        if metadata['size'] != row.byte_size:
            raise UploadError('UPLOAD_SIZE_MISMATCH', 409)
        if metadata['contentType'] != row.content_type:
            raise UploadError('UPLOAD_CONTENT_TYPE_MISMATCH', 422)
        media = storage.primary.open(row.key)
        digest, total, prefix = hashlib.sha256(), 0, b''
        deadline = time.monotonic()+getattr(settings, 'VEEVEE_UPLOAD_VERIFY_SECONDS', 120)
        try:
            for chunk in media.stream:
                if time.monotonic() > deadline:
                    raise UploadError('UPLOAD_VERIFICATION_TIMEOUT', 503)
                total += len(chunk)
                if total > row.byte_size:
                    raise UploadError('UPLOAD_SIZE_MISMATCH', 409)
                prefix = (prefix+chunk)[:128] if len(prefix) < 128 else prefix
                digest.update(chunk)
        finally:
            media.stream.close()
        if total != row.byte_size:
            raise UploadError('UPLOAD_SIZE_MISMATCH', 409)
        if not _sniff(prefix, row.content_type):
            raise UploadError('UPLOAD_SIGNATURE_MISMATCH', 422)
        if row.sha256 and row.sha256 != digest.hexdigest():
            raise UploadError('UPLOAD_CHECKSUM_MISMATCH', 422)
        row.sha256, row.state, row.finalized_at = digest.hexdigest(), 'ready', timezone.now()
        row.session_uri = ''
        row.save(update_fields=['sha256', 'state', 'finalized_at', 'session_uri'])
        return session_result(row, storage)


def resolve_owned_ready_upload(actor_id, reference_id, *, purposes=None):
    """Owner-only resolution for flows that register an upload under the actor (portraits)."""
    row = _owned_session(actor_id, reference_id)
    if not row.finalized_at or row.state != 'ready':
        raise UploadError('UPLOAD_NOT_READY', 409)
    if purposes and row.purpose not in purposes:
        raise UploadError('UPLOAD_PURPOSE_MISMATCH', 403)
    return row


def resolve_ready_upload(actor_id, reference_id, *, purposes=None):
    """Resolve a READY upload for use as a reference by any authenticated actor.

    The owner path keeps its cancelled/expired errors. Mutations (finalize,
    cancel, status) still go through ``_owned_session`` and stay owner-only.
    """
    try:
        shared = _session_model().objects.filter(id=reference_id).first()
    except (ValueError, ValidationError):
        shared = None
    if shared is not None and str(shared.actor_id) != str(actor_id):
        if shared.state == 'cancelled':
            raise UploadError('UPLOAD_CANCELLED', 410)
        if not shared.finalized_at or shared.state != 'ready':
            raise UploadError('UPLOAD_NOT_READY', 409)
        if purposes and shared.purpose not in purposes:
            raise UploadError('UPLOAD_PURPOSE_MISMATCH', 403)
        return shared
    row = _owned_session(actor_id, reference_id)
    if not row.finalized_at or row.state != 'ready':
        raise UploadError('UPLOAD_NOT_READY', 409)
    if purposes and row.purpose not in purposes:
        raise UploadError('UPLOAD_PURPOSE_MISMATCH', 403)
    return row


def stream_local_chunk(actor_id, session_id, request, storage):
    if not isinstance(storage.primary, FileSystemAdapter):
        raise UploadError('LOCAL_UPLOAD_UNAVAILABLE', 404)
    with transaction.atomic():
        row = _owned_session(actor_id, session_id, locked=True)
        if row.finalized_at:
            return 200, row.byte_size
        part = _local_path(storage, row)
        part.parent.mkdir(parents=True, exist_ok=True)
        offset = part.stat().st_size if part.exists() else 0
        if not part.exists():
            try:
                if _metadata(storage, row.key)['size'] == row.byte_size:
                    return 200, row.byte_size
            except MediaNotFoundError:
                pass
        value = request.headers.get('Content-Range', '')
        if value == f'bytes */{row.byte_size}':
            if offset == row.byte_size:
                with part.open('rb') as stream:
                    storage.primary.put_stream(row.key, stream, row.content_type, 'private, no-store')
                return 200, offset
            return 308, offset
        match = re.fullmatch(r'bytes ([0-9]+)-([0-9]+)/([0-9]+)', value)
        if not match:
            raise UploadError('INVALID_CONTENT_RANGE')
        start, end, size = map(int, match.groups())
        length = end-start+1
        if size != row.byte_size or start != offset or end >= size or length <= 0:
            raise UploadError('UPLOAD_OFFSET_CONFLICT', 409)
        if length > CHUNK_BYTES or (end+1 < size and length % (256*1024)):
            raise UploadError('INVALID_CHUNK_SIZE', 413)
        if request.headers.get('Content-Type') != row.content_type:
            raise UploadError('UPLOAD_CONTENT_TYPE_MISMATCH')
        try:
            if int(request.headers.get('Content-Length', '0')) != length:
                raise UploadError('UPLOAD_CHUNK_LENGTH_MISMATCH')
        except ValueError:
            raise UploadError('INVALID_CONTENT_LENGTH')
        with part.open('ab') as output:
            count = 0
            deadline = time.monotonic()+120
            try:
                while chunk := request.read(min(256*1024, length-count+1)):
                    if time.monotonic() > deadline:
                        raise UploadError('UPLOAD_CHUNK_TIMEOUT', 408)
                    count += len(chunk)
                    if count > length:
                        raise UploadError('UPLOAD_CHUNK_LENGTH_MISMATCH')
                    output.write(chunk)
                if count != length:
                    raise UploadError('UPLOAD_CHUNK_LENGTH_MISMATCH')
            except Exception:
                output.truncate(offset)
                raise
        offset += count
        if offset == size:
            with part.open('rb') as stream:
                storage.primary.put_stream(row.key, stream, row.content_type, 'private, no-store')
            part.unlink(missing_ok=True)
            return 200, offset
        return 308, offset


def cancel_upload(actor_id, session_id, storage):
    with transaction.atomic():
        row = _session_model().objects.select_for_update().filter(id=session_id, actor_id=actor_id).first()
        if not row:
            raise UploadError('UPLOAD_NOT_FOUND', 404)
        if row.finalized_at:
            raise UploadError('UPLOAD_ALREADY_READY', 409)
        if row.state == 'cancelled':
            return {'version': 1, 'uploadId': str(row.id), 'state': 'cancelled'}
        if isinstance(storage.primary, GCSAdapter) and row.session_uri:
            import requests
            uri = _cipher().decrypt(row.session_uri.encode()).decode()
            from .storage import validate_gcs_session_uri
            validate_gcs_session_uri(uri)
            response = requests.delete(uri, timeout=15, allow_redirects=False)
            # GCS uses 499 for successful cancellation; 404/410 are already gone.
            if response.status_code not in (200, 204, 404, 410, 499):
                raise UploadError('UPLOAD_CANCEL_UNAVAILABLE', 503)
        if isinstance(storage.primary, FileSystemAdapter):
            _local_path(storage, row).unlink(missing_ok=True)
        # Only this new, unpublished, actor-owned staging object can be deleted.
        storage.primary.delete(row.key)
        row.state, row.session_uri = 'cancelled', ''
        row.save(update_fields=['state', 'session_uri'])
        return {'version': 1, 'uploadId': str(row.id), 'state': 'cancelled'}


def cleanup_expired_uploads(storage, *, limit=100):
    """Bounded orphan collector; READY rows and legacy/catalog objects are excluded."""
    cleaned = 0
    candidates = list(_session_model().objects.filter(state='uploading',
        finalized_at__isnull=True, expires_at__lte=timezone.now()).values_list('id', 'actor_id')[:limit])
    for identifier, actor_id in candidates:
        cancel_upload(actor_id, identifier, storage)
        cleaned += 1
    return cleaned
