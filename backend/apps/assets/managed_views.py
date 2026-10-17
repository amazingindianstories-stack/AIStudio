"""HTTP API for the Portrait Gallery (automatic BytePlus pool) and the admin portrait settings.

Users never see BytePlus: no provider ids, group names or slot counts leave this module.
The Gallery is one shared, flat list; anyone signed in may rename or delete.
"""
import base64
import functools
import time
import uuid
from datetime import datetime, timezone

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import Max, Q

from apps.authentication.session import lookup
from apps.canvas.views import body, failure, node_route, reply
from apps.common.responses import log_activity
from apps.generation import image_limits
from apps.media.storage import get_storage
from apps.media.uploads import UploadError, resolve_owned_ready_upload

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin

SHOWN = ('QUEUED', 'REGISTERING', 'PROCESSING', 'ACTIVE', 'UNCERTAIN', 'FAILED')
PREPARING = ('REGISTERING', 'PROCESSING', 'UNCERTAIN')
PAGE_MAX, BATCH_MAX, DELETE_MAX, NAME_MAX = 100, 50, 200, 120
MAX_IMAGE_BYTES = 30 * 1024 * 1024          # the provider's own limit for a registered image
UNUSABLE = "This image can't be used as a portrait."
WAITING = 'Waiting for space - other generations are using it.'
UPLOAD_ERRORS = {
    'UPLOAD_NOT_FOUND': 'This upload was not found. Add the image again.',
    'UPLOAD_NOT_READY': 'This upload has not finished. Wait for it to complete.',
    'UPLOAD_PURPOSE_MISMATCH': 'This file was not uploaded as a portrait.',
    'UPLOAD_CANCELLED': 'This upload was cancelled.',
    'UPLOAD_EXPIRED': 'This upload expired. Add the image again.',
}


def enabled():
    return bool(getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False))


def problem(request, code, message, status):
    return reply(request, {'error': code, 'code': code, 'message': message}, status)


def retired_in_managed_mode(view):
    """With the automatic pool on, the old manual portrait routes answer 410 on every method."""
    @functools.wraps(view)
    def guarded(request, *args, **kwargs):
        if enabled():
            return problem(request, 'PORTRAITS_ARE_AUTOMATIC', 'Portraits are created automatically. This route is turned off.', 410)
        return view(request, *args, **kwargs)
    return guarded


def gallery_route(methods, listing=False):
    """Signed-in session; 404 PORTRAITS_DISABLED when the flag is off (the list answers an empty, disabled gallery)."""
    def decorate(handler):
        @node_route(methods)
        @functools.wraps(handler)
        def route(request, *args, **kwargs):
            user = lookup(request)
            if user is None:
                return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
            if not enabled():
                if listing and request.method in ('GET', 'HEAD'):
                    return reply(request, {'enabled': False, 'portraits': [], 'next': None})
                return problem(request, 'PORTRAITS_DISABLED', 'Portraits are not available.', 404)
            try:
                return handler(request, user, *args, **kwargs)
            except Exception:
                return failure()
        return route
    return decorate


def visible():
    """Gallery rows: live, not deleted by a user, and no failed automatic faces (nobody asked for those)."""
    return (ManagedPortraitAsset.objects.filter(status__in=SHOWN, hidden_at__isnull=True)
            .exclude(status='FAILED', origin='reference'))


def display_name(asset, creator):
    if asset.name:
        return asset.name
    first = (creator.name or '').split(' ')[0] if creator else ''
    day = datetime.fromtimestamp(asset.created_at / 1000, timezone.utc)
    return f'Face from {first or "prompt"} {day:%b} {day.day}'


def serialize(asset, pins, creators, room=True):
    creator = creators.get(asset.created_by_id)
    if asset.status == 'ACTIVE':
        state, message = 'ready', None
    elif asset.status == 'FAILED':
        state, message = 'unusable', UNUSABLE
    elif asset.status == 'QUEUED' and (not room or asset.error_code == 'QuotaSharedPoolExceeded'):   # with room, simply next in line
        state, message = 'waiting', WAITING
    else:
        state, message = 'preparing', 'Preparing...'
    return {'id': str(asset.id), 'name': display_name(asset, creator), 'origin': asset.origin,
            'imageUrl': '/api/media/' + asset.source_key if asset.source_key else None, 'state': state, 'message': message,
            'createdBy': {'id': str(creator.id), 'name': creator.name, 'email': creator.email, 'avatarUrl': creator.avatar_url} if creator else None,
            'createdAt': asset.created_at, 'inUse': pins.get(asset.id, 0) > 0}


def serialize_rows(rows):
    from apps.authentication.models import User
    pins = {}
    for asset_id in ManagedPortraitPin.objects.filter(asset_id__in=[row.id for row in rows]).values_list('asset_id', flat=True):
        pins[asset_id] = pins.get(asset_id, 0) + 1
    creators = {user.id: user for user in User.objects.filter(id__in={row.created_by_id for row in rows if row.created_by_id})}
    room = managed_pool.has_room() if any(row.status == 'QUEUED' for row in rows) else True
    return [serialize(row, pins, creators, room) for row in rows]


def encode_cursor(row):
    return base64.urlsafe_b64encode(f'{row.created_at}:{row.id}'.encode()).decode().rstrip('=')


def decode_cursor(value):
    created, identifier = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)).decode().split(':', 1)
    return int(created), uuid.UUID(identifier)


def portraits_list(request, user):
    try:
        limit = min(PAGE_MAX, max(1, int(request.GET.get('limit') or PAGE_MAX)))
        cursor = decode_cursor(request.GET['cursor']) if request.GET.get('cursor') else None
    except (ValueError, UnicodeError):
        return problem(request, 'BAD_REQUEST', 'Invalid page request.', 400)
    rows = visible()
    needle = (request.GET.get('q') or '').strip()[:NAME_MAX]
    if needle:
        match = Q(name__icontains=needle)
        if needle.lower() in 'face from prompt':        # automatic faces have no stored name; they show a generated "Face from ..."
            match |= Q(name__isnull=True)
        rows = rows.filter(match)
    if cursor:
        rows = rows.filter(Q(created_at__lt=cursor[0]) | Q(created_at=cursor[0], id__lt=cursor[1]))
    page = list(rows.order_by('-created_at', '-id')[:limit + 1])
    more = len(page) > limit
    page = page[:limit]
    return reply(request, {'enabled': True, 'portraits': serialize_rows(page), 'next': encode_cursor(page[-1]) if more and page else None})


@gallery_route(['GET', 'POST'], listing=True)
def portraits_collection(request, user):
    return portraits_list(request, user) if request.method in ('GET', 'HEAD') else portraits_create(request, user)


def clean_name(value):
    value = value.strip() if isinstance(value, str) else ''
    return value if 0 < len(value) <= NAME_MAX else None


def register_one(user, item, created_at):
    """One Gallery upload: a result for the response. Creates (or re-shows) a QUEUED pool row; no provider call."""
    reference_id = item.get('referenceId') if isinstance(item, dict) else None
    if not isinstance(reference_id, str):
        return {'referenceId': reference_id, 'ok': False, 'error': 'BAD_REQUEST', 'message': 'Each upload needs a referenceId.'}

    def refuse(code, message):
        return {'referenceId': reference_id, 'ok': False, 'error': code, 'message': message}
    try:
        row = resolve_owned_ready_upload(user.id, reference_id, purposes={'portrait'})
    except UploadError as error:
        return refuse(error.code, UPLOAD_ERRORS.get(error.code, 'This upload cannot be used.'))
    except (ValueError, ValidationError):
        return refuse('UPLOAD_NOT_FOUND', UPLOAD_ERRORS['UPLOAD_NOT_FOUND'])
    name = item.get('name')
    if isinstance(name, str) and len(name.strip()) > NAME_MAX:
        return refuse('INVALID_NAME', f'Names can be up to {NAME_MAX} characters.')
    name = clean_name(name) or clean_name(row.filename.rsplit('.', 1)[0] if row.filename else '') or 'Portrait'
    if not (row.content_type or '').startswith('image/') or not row.sha256:
        return refuse('PORTRAIT_NOT_IMAGE', UNUSABLE)
    if row.byte_size > MAX_IMAGE_BYTES:
        return refuse('PORTRAIT_TOO_LARGE', 'This image is larger than 30 MB. Use a smaller file.')
    dimensions = image_limits.stored_dimensions(get_storage(), row.key)      # a bounded header read, never a full decode
    problem_kind = image_limits.side_problem(*dimensions) if dimensions else None
    if problem_kind == 'size':
        return refuse('PORTRAIT_IMAGE_SIZE', f'This image is {dimensions[0]} x {dimensions[1]} px. Portraits need at least '
                      f'{image_limits.MIN_SIDE} px and at most {image_limits.MAX_SIDE} px on each side.')
    if problem_kind == 'ratio':
        return refuse('PORTRAIT_IMAGE_RATIO', f'This image is {dimensions[0]} x {dimensions[1]} px. Portraits need a width to height '
                      f'ratio between {image_limits.MIN_RATIO:g} and {image_limits.MAX_RATIO:g}, so not too wide or too tall.')
    now = managed_pool.now_ms()
    values = managed_pool.setting_values()
    with transaction.atomic():
        managed_pool._locked()
        managed_pool.force_face(row.sha256, 'upload', now)      # always a face, so prompts that use this image share the asset
        existing = ManagedPortraitAsset.objects.select_for_update().exclude(status__in=('DELETED', 'FAILED')).filter(content_sha256=row.sha256).first()
        if existing is not None and existing.status == 'DELETING':
            return refuse('PORTRAIT_REMOVING', 'This image is being removed. Try again in a moment.')
        if existing is not None:
            existing.hidden_at = None
            existing.name = existing.name or name
            existing.updated_at = now
            fields = ['hidden_at', 'name', 'updated_at']
            if existing.status == 'ACTIVE':
                existing.last_used_at, existing.expires_at = now, now + values['portraitAssetTtlHours'] * 3600 * 1000
                fields += ['last_used_at', 'expires_at']
            existing.save(update_fields=fields)
            return {'referenceId': reference_id, 'ok': True, 'portrait': existing, 'existing': True}
        created = ManagedPortraitAsset.objects.create(id=uuid.uuid4(), content_sha256=row.sha256, source_key=row.key, status='QUEUED',
            receipt={'version': 1, 'state': 'QUEUED'}, created_by_id=user.id, created_at=created_at, updated_at=now, last_used_at=now,
            name=name, origin='upload')
    return {'referenceId': reference_id, 'ok': True, 'portrait': created, 'existing': False}


def portraits_create(request, user):
    uploads = (body(request) or {}).get('uploads')
    if not isinstance(uploads, list) or not 1 <= len(uploads) <= BATCH_MAX:
        return problem(request, 'PORTRAIT_BATCH_LIMIT', f'Add between 1 and {BATCH_MAX} images at a time.', 400)
    # Request order is queue order: created_at strictly increases along the array (and after every earlier row).
    stamp = max(managed_pool.now_ms(), (ManagedPortraitAsset.objects.aggregate(top=Max('created_at'))['top'] or 0) + 1)
    results = []
    for index, item in enumerate(uploads):
        try:
            results.append(register_one(user, item, stamp + index))
        except IntegrityError:      # a concurrent request registered the same image first; show what it made
            results.append(register_one(user, item, stamp + index))
    shown = serialize_rows([result['portrait'] for result in results if result['ok']])
    for result in results:
        if result['ok']:
            result['portrait'] = shown.pop(0)
    log_activity(user.id, 'add_portraits', {'count': sum(1 for result in results if result['ok'])})
    return reply(request, {'results': results})


@gallery_route(['PATCH'])
def portraits_rename(request, user, id):
    name = clean_name((body(request) or {}).get('name'))
    if name is None:
        return problem(request, 'INVALID_NAME', f'Enter a name of 1 to {NAME_MAX} characters.', 400)
    asset = visible().filter(pk=id).first()
    if asset is None:
        return problem(request, 'NOT_FOUND', 'This portrait was not found.', 404)
    asset.name, asset.updated_at = name, managed_pool.now_ms()
    asset.save(update_fields=['name', 'updated_at'])
    log_activity(user.id, 'rename_portrait', {'id': str(asset.id)})
    return reply(request, {'portrait': serialize_rows([asset])[0]})


def remove_one(identifier, now):
    """Under the pool lock: take one portrait out of the Gallery. True when it was there."""
    try:
        asset = visible().select_for_update().filter(pk=identifier).first()
    except (ValueError, ValidationError):
        return False
    if asset is None:
        return False
    if ManagedPortraitPin.objects.filter(asset=asset).exists() or asset.status in PREPARING:
        # Held by a generation (or still being prepared): hidden now, removed as soon as nothing holds it.
        asset.hidden_at, asset.expires_at, asset.updated_at = now, now, now
        asset.save(update_fields=['hidden_at', 'expires_at', 'updated_at'])
    elif asset.status == 'ACTIVE':
        managed_pool._mark_deleting(asset, 'user', now)      # the scheduler deletes it remotely within seconds
    else:       # QUEUED or FAILED: nothing exists remotely
        asset.status, asset.deleted_at, asset.updated_at = 'DELETED', now, now
        asset.save(update_fields=['status', 'deleted_at', 'updated_at'])
    return True


@gallery_route(['POST'])
def portraits_delete(request, user):
    ids = (body(request) or {}).get('ids')
    if not isinstance(ids, list) or not 1 <= len(ids) <= DELETE_MAX:
        return problem(request, 'BAD_REQUEST', f'Choose between 1 and {DELETE_MAX} portraits.', 400)
    now, outcomes, results = managed_pool.now_ms(), {}, []
    for identifier in ids:
        key = str(identifier)
        if key not in outcomes:
            with transaction.atomic():
                managed_pool._locked()
                outcomes[key] = remove_one(key, now)
        results.append({'id': key, 'ok': True} if outcomes[key] else {'id': key, 'ok': False, 'error': 'NOT_FOUND'})
    log_activity(user.id, 'delete_portraits', {'count': sum(1 for result in results if result['ok'])})
    return reply(request, {'results': results})


@node_route(['GET', 'POST'])
def portrait_settings(request):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    if user.role != 'admin':
        return reply(request, {'error': 'FORBIDDEN'}, 403)
    try:
        if request.method == 'POST':
            from apps.admin_dashboard.models import AppSetting
            data = body(request) or {}
            key, value = data.get('key'), data.get('value')
            if key not in managed_pool.SETTINGS:
                return reply(request, {'error': 'Unknown setting.'}, 400)
            _, minimum, maximum = managed_pool.SETTINGS[key]
            if isinstance(value, float) and value.is_integer():
                value = int(value)          # JSON numbers arrive with JavaScript semantics
            if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
                return reply(request, {'error': f'Enter a whole number from {minimum} to {maximum}.'}, 400)
            AppSetting.objects.update_or_create(key=key, defaults={'value': str(value), 'updated_at': int(time.time() * 1000)})
        return reply(request, {'enabled': enabled(), 'settings': managed_pool.setting_values(),
                               'ranges': {k: {'min': v[1], 'max': v[2], 'default': v[0]} for k, v in managed_pool.SETTINGS.items()},
                               'usage': managed_pool.usage() if enabled() else None})
    except Exception:
        return failure()
