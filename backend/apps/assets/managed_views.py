"""HTTP API for the automatic portrait pool (Gallery view, delete, admin settings)."""
import functools
import time

from django.conf import settings
from django.db import transaction

from apps.authentication.session import lookup
from apps.canvas.views import body, failure, node_route, reply

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin

VISIBLE = ('REGISTERING', 'PROCESSING', 'ACTIVE', 'DELETING', 'UNCERTAIN', 'FAILED')
STATUS_LABELS = {'REGISTERING': 'Preparing', 'PROCESSING': 'Preparing', 'ACTIVE': 'Ready', 'DELETING': 'Removing',
                 'UNCERTAIN': 'Checking', 'FAILED': 'Failed'}


def enabled():
    return bool(getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False))


def manual_upload_guard(view):
    """With the automatic pool on, portraits are created from references; manual uploads are refused."""
    @functools.wraps(view)
    def guarded(request, *args, **kwargs):
        if enabled() and request.method == 'POST':
            return reply(request, {'error': 'Portraits are created automatically from your references. Manual upload is turned off.',
                                   'code': 'PORTRAITS_ARE_AUTOMATIC'}, 410)
        return view(request, *args, **kwargs)
    return guarded


def serialize(asset, pins, names):
    key = asset.source_key
    return {'id': str(asset.id), 'status': asset.status, 'label': STATUS_LABELS.get(asset.status, asset.status),
            'imageUrl': '/api/media/' + key if key else None, 'createdBy': names.get(asset.created_by_id),
            'createdAt': asset.created_at, 'lastUsedAt': asset.last_used_at, 'expiresAt': asset.expires_at,
            'inUse': pins.get(asset.id, 0), 'errorCode': asset.error_code if asset.status == 'FAILED' else None}


@node_route(['GET'])
def managed_list(request):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    if not enabled():
        return reply(request, {'enabled': False, 'assets': []})
    try:
        from apps.authentication.models import User
        rows = list(ManagedPortraitAsset.objects.filter(status__in=VISIBLE).order_by('-last_used_at')[:500])
        pins = {}
        for asset_id in ManagedPortraitPin.objects.filter(asset_id__in=[r.id for r in rows]).values_list('asset_id', flat=True):
            pins[asset_id] = pins.get(asset_id, 0) + 1
        creators = {r.created_by_id for r in rows if r.created_by_id}
        names = {u.id: u.name for u in User.objects.filter(id__in=creators).only('id', 'name')}
        return reply(request, {'enabled': True, 'usage': managed_pool.usage(), 'assets': [serialize(r, pins, names) for r in rows]})
    except Exception:
        return failure()


@node_route(['DELETE'])
def managed_delete(request, id):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    if not enabled():
        return reply(request, {'error': 'NOT_FOUND'}, 404)
    try:
        now = int(time.time() * 1000)
        with transaction.atomic():
            managed_pool._locked()
            asset = ManagedPortraitAsset.objects.select_for_update().filter(pk=id, status__in=('ACTIVE', 'FAILED')).first()
            if asset is None:
                return reply(request, {'error': 'This portrait is busy or already removed. Refresh and try again.', 'code': 'NOT_DELETABLE'}, 409)
            if ManagedPortraitPin.objects.filter(asset=asset).exists():
                return reply(request, {'error': 'This portrait is being used by a generation right now. Try again when it finishes.',
                                       'code': 'PORTRAIT_IN_USE'}, 409)
            asset.status, asset.updated_at = 'DELETING', now
            asset.receipt = {**asset.receipt, 'delete': {'state': 'CLAIMED', 'reason': 'user', 'actor': str(user.id), 'at': now}}
            asset.save(update_fields=['status', 'updated_at', 'receipt'])
        freed = managed_pool.remote_delete(asset, managed_pool.default_client())
        return reply(request, {'ok': True, 'removed': freed, 'id': str(asset.id)})
    except ValueError:
        return reply(request, {'error': 'NOT_FOUND'}, 404)
    except Exception:
        return failure()


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
