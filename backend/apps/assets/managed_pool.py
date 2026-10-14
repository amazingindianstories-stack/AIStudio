"""Automatic BytePlus portrait pool: register face references on demand, expire, evict.

Invariants (each has tests):
- One allocator: every state change runs in a short transaction under one advisory
  lock. No network call happens while the lock is held.
- A pinned asset (used by a queued/running generation) is never expired or evicted.
- A registration is claimed in the database before CreateAsset; an outcome we cannot
  confirm becomes UNCERTAIN and is never retried blindly (the janitor reconciles it).
- Deletion is confirmed by BytePlus before a row becomes DELETED.
- Our original images are never modified; out-of-bounds images get a derived copy.
"""
import hashlib
import io
import json
import re
import time
import uuid
from dataclasses import dataclass
from urllib.parse import parse_qs, urlsplit

from django.db import connection, transaction

from apps.generation.providers.transport import HttpTransport

from .models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool, ReferenceFaceScan

POOL_LOCK = 7461122019
LIVE = ('REGISTERING', 'PROCESSING', 'ACTIVE', 'DELETING', 'UNCERTAIN')   # occupy (or may occupy) a remote slot
ASSET_HOST = 'ark.ap-southeast-1.byteplusapi.com'
NAME_PREFIX = 'veevee-'
SETTINGS = {'portraitAssetTtlHours': (4, 1, 72), 'portraitPoolCapacity': (90, 1, 10000), 'portraitQueueWaitMinutes': (15, 1, 240)}
PROCESSING_LIMIT_MS = 3 * 60 * 1000
REGISTERING_STALE_MS = 2 * 60 * 1000
VERIFY_INTERVAL_MS = 60 * 1000           # re-confirm an ACTIVE asset with BytePlus (unbilled GetAsset) before a submission at most this often
MIN_SIDE, MAX_SIDE, MIN_RATIO, MAX_RATIO = 300, 6000, 0.4, 2.5


def now_ms():
    return int(time.time() * 1000)


# ---------------------------------------------------------------- outcomes
@dataclass
class Outcome:
    kind: str                 # 'ready' | 'wait' | 'failed'
    asset_id: str = None      # BytePlus asset id when ready
    reason: str = ''
    delay_ms: int = 0
    message: str = ''


def ready(asset_id):
    return Outcome('ready', asset_id=asset_id)


def wait(reason, delay_ms):
    return Outcome('wait', reason=reason, delay_ms=delay_ms)


def failed(message, reason='failed'):
    return Outcome('failed', reason=reason, message=message)


# ---------------------------------------------------------------- BytePlus transport
class PoolAssetTransport(HttpTransport):
    """Exact allowlist for the pool's BytePlus asset-library calls (not generation; exempt from the paid guard)."""
    paid_guard_exempt = True
    ACTIONS = {
        'CreateAssetGroup': {'Name', 'Description', 'GroupType', 'ProjectName'},
        'GetAssetGroup': {'Id', 'ProjectName'},
        'CreateAsset': {'GroupId', 'URL', 'Name', 'AssetType', 'ProjectName', 'Moderation'},
        'GetAsset': {'Id', 'ProjectName'},
        'ListAssets': {'Filter', 'MaxResults', 'NextToken', 'ProjectName'},
        'DeleteAsset': {'Id', 'ProjectName'},
    }

    def request(self, method, url, **kwargs):
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        action = (query.get('Action') or [''])[0]
        if (method != 'POST' or parts.scheme != 'https' or parts.netloc != ASSET_HOST or parts.path != '/'
                or set(query) != {'Action', 'Version'} or query['Version'] != ['2024-01-01'] or action not in self.ACTIONS):
            raise ValueError('Portrait pool transport target mismatch')
        payload = json.loads(kwargs.get('raw_body') or b'{}')
        if not set(payload) <= self.ACTIONS[action] or payload.get('ProjectName', 'default') != 'default':
            raise ValueError('Portrait pool transport payload mismatch')
        return super().request(method, url, **kwargs)


def default_client():
    from .byteplus import BytePlusClient, config_from_env
    config = config_from_env()
    config['is_mock'] = False
    return BytePlusClient(config, transport=PoolAssetTransport(allowed_hosts={ASSET_HOST}, timeout=30))


# ---------------------------------------------------------------- settings
def setting_values():
    from apps.admin_dashboard.models import AppSetting
    from apps.admin_dashboard.views import parse
    stored = {row.key: row.value for row in AppSetting.objects.filter(key__in=list(SETTINGS))}
    return {key: parse(stored.get(key), definition) for key, definition in SETTINGS.items()}


def effective_capacity(values, pool):
    capacity = values['portraitPoolCapacity']
    if pool.observed_capacity:
        capacity = min(capacity, max(1, pool.observed_capacity))
    return capacity


# ---------------------------------------------------------------- face scan
def content_sha256(data):
    return hashlib.sha256(data).hexdigest()


def scan_reference(data, *, scanner=None, now=None):
    """Cached face scan for these exact bytes."""
    sha = content_sha256(data)
    cached = ReferenceFaceScan.objects.filter(pk=sha).first()
    from .face_detect import DETECTOR_VERSION, scan
    if cached and cached.detector_version == DETECTOR_VERSION and not cached.error:
        return sha, cached.has_face
    result = (scanner or scan)(data)
    ReferenceFaceScan.objects.update_or_create(pk=sha, defaults={'has_face': result['has_face'], 'faces': result['faces'],
        'detector_version': DETECTOR_VERSION, 'error': result['error'], 'scanned_at': now or now_ms()})
    return sha, result['has_face']


def bounded_copy(data):
    """None if BytePlus accepts the image as is, else (jpeg_bytes) padded/resized into bounds."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(data)) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
    width, height = image.size
    ratio = width / height
    if MIN_SIDE <= min(width, height) and max(width, height) <= MAX_SIDE and MIN_RATIO <= ratio <= MAX_RATIO and len(data) <= 30 * 1024 * 1024:
        return None
    if ratio > MAX_RATIO or ratio < MIN_RATIO:      # pad (never crop a face away)
        if ratio > MAX_RATIO:
            canvas = Image.new('RGB', (width, round(width / MAX_RATIO)), (0, 0, 0))
        else:
            canvas = Image.new('RGB', (round(height * MIN_RATIO), height), (0, 0, 0))
        canvas.paste(image, ((canvas.width - width) // 2, (canvas.height - height) // 2))
        image = canvas
    scale = 1.0
    if min(image.size) < MIN_SIDE:
        scale = MIN_SIDE / min(image.size)
    if max(image.size) * scale > MAX_SIDE:
        scale = MAX_SIDE / max(image.size)
    if scale != 1.0:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))))
    out = io.BytesIO()
    image.save(out, format='JPEG', quality=92)
    return out.getvalue()


# ---------------------------------------------------------------- locked state changes
def _locked():
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_advisory_xact_lock(%s)', [POOL_LOCK])


def _pool():
    pool, _ = ManagedPortraitPool.objects.select_for_update().get_or_create(pk=1, defaults={'updated_at': now_ms()})
    return pool


def pin(generation_id, asset):
    ManagedPortraitPin.objects.get_or_create(generation_id=generation_id, asset=asset, defaults={'pinned_at': now_ms()})


def require_verification(generation_id):
    """The next use of this generation's ACTIVE assets re-confirms them with BytePlus first."""
    with transaction.atomic():
        _locked()
        for asset in ManagedPortraitAsset.objects.select_for_update().filter(
                status='ACTIVE', id__in=ManagedPortraitPin.objects.filter(generation_id=generation_id).values('asset_id')):
            asset.receipt = {**(asset.receipt or {}), 'verified_at': 0}
            asset.save(update_fields=['receipt'])


def release_pins(generation_id):
    return ManagedPortraitPin.objects.filter(generation_id=generation_id).delete()[0]


def _touch(asset, values, now):
    asset.last_used_at = now
    asset.expires_at = now + values['portraitAssetTtlHours'] * 3600 * 1000
    asset.updated_at = now
    asset.save(update_fields=['last_used_at', 'expires_at', 'updated_at'])


def _activated(asset, values, now):
    """Under the pool lock, once ``asset`` is ACTIVE: start its expiry and retire earlier failed attempts
    for the same image (a FAILED row never holds a remote asset, so it only cluttered the Gallery)."""
    _touch(asset, values, now)
    (ManagedPortraitAsset.objects.filter(content_sha256=asset.content_sha256, status='FAILED')
     .update(status='DELETED', deleted_at=now, updated_at=now))


def _claim(sha, source_key, generation_id, user_id, now):
    """Under the pool lock: decide what this reference needs. Returns (outcome_or_None, asset, action)."""
    values = setting_values()
    with transaction.atomic():
        _locked()
        pool = _pool()
        asset = ManagedPortraitAsset.objects.filter(content_sha256=sha, status__in=LIVE).first()
        if asset is not None:
            pin(generation_id, asset)
            if asset.status == 'ACTIVE':
                if now - int((asset.receipt or {}).get('verified_at') or 0) > VERIFY_INTERVAL_MS:
                    return None, asset, 'verify'
                _touch(asset, values, now)
                return ready(asset.byteplus_asset_id), asset, None
            if asset.status == 'PROCESSING':
                return None, asset, 'poll'
            if asset.status == 'REGISTERING' and now - asset.updated_at > REGISTERING_STALE_MS:
                asset.status, asset.updated_at = 'UNCERTAIN', now
                asset.save(update_fields=['status', 'updated_at'])
            return wait('portrait_' + asset.status.lower(), 5000), asset, None
        live = ManagedPortraitAsset.objects.filter(status__in=LIVE).count()
        if live < effective_capacity(values, pool):
            asset = ManagedPortraitAsset.objects.create(id=uuid.uuid4(), content_sha256=sha, source_key=source_key, status='REGISTERING',
                receipt={'version': 1, 'state': 'CLAIMED', 'attempt': str(uuid.uuid4())}, created_by_id=user_id,
                created_at=now, updated_at=now, last_used_at=now)
            pin(generation_id, asset)
            return None, asset, 'register'
        pinned = ManagedPortraitPin.objects.values('asset_id')
        victim = (ManagedPortraitAsset.objects.select_for_update().filter(status='ACTIVE').exclude(id__in=pinned)
                  .order_by('last_used_at', 'created_at').first())
        if victim is None:
            return wait('portrait_pool_full', 15000), None, None
        victim.status, victim.updated_at = 'DELETING', now
        victim.receipt = {**victim.receipt, 'delete': {'state': 'CLAIMED', 'reason': 'evicted', 'at': now}}
        victim.save(update_fields=['status', 'updated_at', 'receipt'])
        return wait('portrait_evicting', 1000), victim, 'delete'


def _finish(asset, **fields):
    with transaction.atomic():
        _locked()
        row = ManagedPortraitAsset.objects.select_for_update().get(pk=asset.pk)
        for key, value in fields.items():
            setattr(row, key, value)
        row.updated_at = now_ms()
        row.save()
        return row


def ensure_group(client):
    with transaction.atomic():
        _locked()
        pool = _pool()
        if pool.byteplus_group_id:
            return pool.byteplus_group_id
    created = client.create_asset_group('veevee-managed-portraits', 'Automatic portrait pool (expires after use)')
    with transaction.atomic():
        _locked()
        pool = _pool()
        if not pool.byteplus_group_id:
            pool.byteplus_group_id, pool.updated_at = created['Id'], now_ms()
            pool.save(update_fields=['byteplus_group_id', 'updated_at'])
        return pool.byteplus_group_id


def forget_group(group_id):
    with transaction.atomic():
        _locked()
        ManagedPortraitPool.objects.filter(pk=1, byteplus_group_id=group_id).update(byteplus_group_id=None, updated_at=now_ms())


def remote_delete(asset, client):
    """Delete remotely with a verified outcome. Returns True when the slot is free."""
    from .byteplus import BytePlusAssetError
    if not asset.byteplus_asset_id:
        _finish(asset, status='DELETED', deleted_at=now_ms())
        return True
    try:
        client.delete_asset(asset.byteplus_asset_id)
    except BytePlusAssetError as error:
        if error.code in ('NotFound.asset_id', 'NotFound'):
            _finish(asset, status='DELETED', deleted_at=now_ms())
            return True
        _finish(asset, status='UNCERTAIN', error_code=str(error.code)[:100])
        return False
    except Exception:
        _finish(asset, status='UNCERTAIN', error_code='delete_unverified')
        return False
    _finish(asset, status='DELETED', deleted_at=now_ms())
    return True


def _register(asset, data, storage, client, user_id):
    from .byteplus import BytePlusAssetError
    key = asset.source_key
    try:
        derived = bounded_copy(data)
    except Exception:
        derived = None
    if derived is not None:
        key = f'portrait-pool/{asset.content_sha256}.jpg'
        storage.write_private_buffer(derived, key, 'image/jpeg')
        asset = _finish(asset, registered_key=key)
    try:
        group_id = ensure_group(client)
        url = storage.signed_read_url(key, 600, actor_id=user_id)
        try:
            response = client.create_asset(group_id, url, name=NAME_PREFIX + asset.content_sha256[:40])
        except BytePlusAssetError as error:
            if error.code != 'NotFound.group_id':
                raise
            # The pool's group was removed outside Veevee; nothing was created, so recreate it and retry once.
            forget_group(group_id)
            response = client.create_asset(ensure_group(client), url, name=NAME_PREFIX + asset.content_sha256[:40])
    except BytePlusAssetError as error:
        if error.code == 'QuotaSharedPoolExceeded':
            with transaction.atomic():
                _locked()
                pool = _pool()
                pool.observed_capacity = max(1, ManagedPortraitAsset.objects.filter(status__in=LIVE).exclude(pk=asset.pk).count())
                pool.last_quota_error_at = pool.updated_at = now_ms()
                pool.save(update_fields=['observed_capacity', 'last_quota_error_at', 'updated_at'])
            _finish(asset, status='FAILED', error_code='QuotaSharedPoolExceeded')
            return wait('portrait_pool_full', 5000)
        definite = isinstance(error.status, int) and 400 <= error.status < 500
        if definite:
            _finish(asset, status='FAILED', error_code=str(error.code)[:100])
            message = ('BytePlus refused this portrait (content check).' if error.code == 'moderation_rejected'
                       else 'BytePlus could not register this portrait.')
            return failed(message + ' Nothing was submitted, so this was not charged.', 'portrait_rejected')
        _finish(asset, status='UNCERTAIN', error_code=str(error.code)[:100])
        return wait('portrait_uncertain', 10000)
    except Exception:
        _finish(asset, status='UNCERTAIN', error_code='create_unverified')
        return wait('portrait_uncertain', 10000)
    identifier = response.get('Id') if isinstance(response, dict) else None
    if not identifier:
        _finish(asset, status='UNCERTAIN', error_code='create_no_id')
        return wait('portrait_uncertain', 10000)
    active = response.get('Status') == 'Active'
    row = _finish(asset, byteplus_asset_id=identifier, status='ACTIVE' if active else 'PROCESSING',
                  receipt={**asset.receipt, 'state': 'ACKNOWLEDGED', 'remote_id': identifier, 'verified_at': now_ms()})
    if active:
        with transaction.atomic():
            _locked()
            _activated(ManagedPortraitAsset.objects.select_for_update().get(pk=row.pk), setting_values(), now_ms())
        return ready(identifier)
    return wait('portrait_processing', 3000)


def _poll(asset, client):
    from .byteplus import BytePlusAssetError
    try:
        remote = client.get_asset(asset.byteplus_asset_id)
    except BytePlusAssetError as error:
        if error.code in ('NotFound.asset_id', 'NotFound'):
            _finish(asset, status='FAILED', error_code='missing_after_create')
            return failed('The portrait disappeared from BytePlus while preparing. Try again.', 'portrait_missing')
        return wait('portrait_processing', 5000)
    except Exception:
        return wait('portrait_processing', 5000)
    status = str((remote or {}).get('Status', ''))
    if status == 'Active':
        with transaction.atomic():
            _locked()
            row = ManagedPortraitAsset.objects.select_for_update().get(pk=asset.pk)
            row.status = 'ACTIVE'
            row.receipt = {**(row.receipt or {}), 'verified_at': now_ms()}
            row.save(update_fields=['status', 'receipt'])
            _activated(row, setting_values(), now_ms())
        return ready(asset.byteplus_asset_id)
    if status == 'Failed' or now_ms() - asset.created_at > PROCESSING_LIMIT_MS:
        _finish(asset, status='DELETING', error_code='processing_failed' if status == 'Failed' else 'processing_timeout')
        remote_delete(asset, client)
        return failed('BytePlus could not prepare this portrait. Nothing was submitted, so this was not charged.', 'portrait_rejected')
    return wait('portrait_processing', 3000)


def _verify(asset, client):
    """An ACTIVE row must still exist at BytePlus (it can be removed outside Veevee). Returns ready/None(gone)/wait."""
    from .byteplus import BytePlusAssetError
    try:
        remote = client.get_asset(asset.byteplus_asset_id)
    except BytePlusAssetError as error:
        if error.code in ('NotFound.asset_id', 'NotFound'):
            _finish(asset, status='DELETED', deleted_at=now_ms(), error_code='missing_remotely')
            return None
        return wait('portrait_processing', 5000)
    except Exception:
        return wait('portrait_processing', 5000)
    if str((remote or {}).get('Status')) != 'Active':
        _finish(asset, status='PROCESSING')
        return wait('portrait_processing', 3000)
    with transaction.atomic():
        _locked()
        row = ManagedPortraitAsset.objects.select_for_update().get(pk=asset.pk)
        row.receipt = {**(row.receipt or {}), 'verified_at': now_ms()}
        row.save(update_fields=['receipt'])
        _touch(row, setting_values(), now_ms())
    return ready(asset.byteplus_asset_id)


def ensure(data, source_key, generation_id, user_id, *, storage, client=None, now=None, _retry=True):
    """Make the face reference with these bytes usable as a BytePlus asset for this generation."""
    client = client or default_client()
    sha = content_sha256(data)
    outcome, asset, action = _claim(sha, source_key, generation_id, user_id, now or now_ms())
    if action == 'verify':
        verified = _verify(asset, client)
        if verified is None and _retry:     # vanished remotely: register it again
            return ensure(data, source_key, generation_id, user_id, storage=storage, client=client, _retry=False)
        return verified or wait('portrait_registering', 1000)
    if action == 'register':
        return _register(asset, data, storage, client, user_id)
    if action == 'poll':
        return _poll(asset, client)
    if action == 'delete':
        remote_delete(asset, client)
    return outcome


# ---------------------------------------------------------------- janitor
def janitor(*, client=None, now=None):
    """Expire unused assets, release stale pins, reconcile uncertain rows. Safe to run concurrently."""
    from apps.generation.models import Generation
    client = client or default_client()
    now = now or now_ms()
    report = {'pins_released': 0, 'expired': 0, 'reconciled': 0}
    terminal = Generation.objects.filter(id__in=ManagedPortraitPin.objects.values('generation_id')).exclude(status__in=('queued', 'running'))
    report['pins_released'] = ManagedPortraitPin.objects.filter(generation_id__in=terminal.values('id')).delete()[0]
    orphan = ManagedPortraitPin.objects.exclude(generation_id__in=Generation.objects.values('id'))
    report['pins_released'] += orphan.delete()[0]
    with transaction.atomic():
        _locked()
        pinned = ManagedPortraitPin.objects.values('asset_id')
        expired = list(ManagedPortraitAsset.objects.select_for_update().filter(status='ACTIVE', expires_at__lt=now).exclude(id__in=pinned))
        for asset in expired:
            asset.status, asset.updated_at = 'DELETING', now
            asset.receipt = {**asset.receipt, 'delete': {'state': 'CLAIMED', 'reason': 'expired', 'at': now}}
            asset.save(update_fields=['status', 'updated_at', 'receipt'])
    for asset in expired:
        report['expired'] += 1 if remote_delete(asset, client) else 0
    stale = ManagedPortraitAsset.objects.filter(status__in=('UNCERTAIN',)).order_by('updated_at')[:20]
    for asset in stale:
        report['reconciled'] += 1 if _reconcile(asset, client) else 0
    return report


def _reconcile(asset, client):
    """Resolve an UNCERTAIN row against BytePlus by our deterministic asset name."""
    from .byteplus import BytePlusAssetError
    try:
        group = ManagedPortraitPool.objects.filter(pk=1).values_list('byteplus_group_id', flat=True).first()
        listing = client.list_assets(group_ids=[group] if group else None, max_results=100)
    except BytePlusAssetError:
        return False
    except Exception:
        return False
    name = NAME_PREFIX + asset.content_sha256[:40]
    match = next((item for item in listing.get('Items', []) if item.get('Name') == name or item.get('Id') == asset.byteplus_asset_id), None)
    if match is None:
        _finish(asset, status='DELETED', deleted_at=now_ms(), error_code='reconciled_absent')
        return True
    pending_delete = (asset.receipt or {}).get('delete', {}).get('state') == 'CLAIMED'
    if pending_delete:
        asset = _finish(asset, byteplus_asset_id=match['Id'])
        return remote_delete(asset, client)
    _finish(asset, byteplus_asset_id=match['Id'], status='ACTIVE' if match.get('Status') == 'Active' else 'PROCESSING',
            receipt={**asset.receipt, 'state': 'RECONCILED', 'remote_id': match['Id']})
    return True


def usage():
    """Dashboard numbers."""
    values = setting_values()
    pool = ManagedPortraitPool.objects.filter(pk=1).first()
    pinned = set(ManagedPortraitPin.objects.values_list('asset_id', flat=True))
    live = list(ManagedPortraitAsset.objects.filter(status__in=LIVE).values('id', 'status'))
    return {'capacity': values['portraitPoolCapacity'], 'observedCapacity': pool.observed_capacity if pool else None,
            'ttlHours': values['portraitAssetTtlHours'], 'queueWaitMinutes': values['portraitQueueWaitMinutes'],
            'live': len(live), 'inUse': sum(1 for row in live if row['id'] in pinned),
            'registering': sum(1 for row in live if row['status'] in ('REGISTERING', 'PROCESSING')),
            'lastQuotaErrorAt': pool.last_quota_error_at if pool else None}
