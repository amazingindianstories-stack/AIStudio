"""Automatic BytePlus portrait pool: register face references on demand, expire, evict.

Invariants (each has tests):
- One allocator: every state change runs in a short transaction under one advisory
  lock. No network call happens while the lock is held.
- A pinned asset (used by a queued/running generation) is never expired or evicted.
- A registration is claimed in the database before CreateAsset; an outcome we cannot
  confirm becomes UNCERTAIN and is never retried blindly (the janitor reconciles it).
- Deletion is confirmed by BytePlus before a row becomes DELETED.
- Our original images are never modified; out-of-bounds images get a derived copy.
- Slots go first come first served: the oldest waiting generation or QUEUED Gallery upload gets the next free
  (or evictable) slot; everyone else waits behind it.
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
from django.db.models import F, Q

from apps.generation.providers.transport import HttpTransport

from .models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool, ManagedPortraitWait, ReferenceFaceScan

POOL_LOCK = 7461122019
LIVE = ('REGISTERING', 'PROCESSING', 'ACTIVE', 'DELETING', 'UNCERTAIN')   # occupy (or may occupy) a remote slot
ASSET_HOST = 'ark.ap-southeast-1.byteplusapi.com'
NAME_PREFIX = 'veevee-'
POOL_GROUP_NAME = 'veevee-portraits'      # the one hidden BytePlus group; adopted by name so it survives a flag off and on
SETTINGS = {'portraitAssetTtlHours': (4, 1, 72), 'portraitPoolCapacity': (90, 1, 10000), 'portraitQueueWaitMinutes': (15, 1, 240)}
REFUSED = 'provider_refused_asset'      # ReferenceFaceScan.forced: the detector saw a face but BytePlus refused the asset, so the image goes inline
PROCESSING_LIMIT_MS = 3 * 60 * 1000
REGISTERING_STALE_MS = 2 * 60 * 1000
DELETING_STALE_MS = 30 * 1000           # a DELETING row nobody finished (the worker that claimed it died)
QUOTA_BACKOFF_MS = 60 * 1000             # after BytePlus reports quota, the pool counts what it accepted as its size for this long
VERIFY_INTERVAL_MS = 60 * 1000           # re-confirm an ACTIVE asset with BytePlus (unbilled GetAsset) before a submission at most this often
MIN_SIDE, MAX_SIDE, MIN_RATIO, MAX_RATIO = 300, 6000, 0.4, 2.5
UPLOADS_PER_PASS, UPLOAD_PASS_SECONDS = 5, 6.0
# BytePlus limits (e.g. QuotaWriteQPMExceeded) answer 400, 429 or 503: a rate limit or overload, never a refusal of the image.
THROTTLED = re.compile(r'Throttl|RateLimit|TooManyRequests|LimitExceeded|QPM|QPS|Overload|Busy|ServiceUnavailable', re.I)
# Only an error about the image itself refuses it as an asset (the image then goes inline); every other error is transient.
CONTENT_REFUSAL = re.compile(r'^moderation_rejected$|^InvalidParameter|^Invalid(Image|Asset|URL)|SensitiveContent|Privacy|^Unsupported(Image|Media)', re.I)
THROTTLE_GIVE_UP_MS = 10 * 60 * 1000     # an image throttled this long without a break is failed, not requeued again
PAUSE_KEY, PAUSE_MS = 'portraitRegisterPauseUntil', 60000      # after a write limit, no new registration for a minute


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
    detail: dict = None       # failed: BytePlus's exact answer (provider_errors record), shown with the message


def ready(asset_id):
    return Outcome('ready', asset_id=asset_id)


def wait(reason, delay_ms):
    return Outcome('wait', reason=reason, delay_ms=delay_ms)


NOT_CHARGED = ' Nothing was submitted, so this was not charged.'
PORTRAIT_REFUSED = 'This portrait was refused (content check).'
PORTRAIT_UNPREPARED = 'This portrait could not be prepared.'
PORTRAIT_UNAVAILABLE = "We couldn't prepare a portrait from one of your references right now."
PORTRAIT_MISSING = 'The portrait disappeared while preparing. Try again.'
PORTRAIT_BUSY = ('Portrait storage stayed busy for {minutes} minutes, so this generation was stopped.' + NOT_CHARGED.replace('submitted, so this', 'submitted, so it')
                 + ' Try again shortly.')


def failed(message, reason='failed', detail=None):
    return Outcome('failed', reason=reason, message=message, detail=detail)


def _last_error(asset, error, **receipt):
    """The asset's receipt with BytePlus's exact answer for this failure (code, message, RequestId) kept for support."""
    record = getattr(error, 'provider_error', None)
    merged = {**(asset.receipt or {}), **receipt}
    return {**merged, 'lastError': record} if isinstance(record, dict) else merged


# ---------------------------------------------------------------- BytePlus transport
class PoolAssetTransport(HttpTransport):
    """Exact allowlist for the pool's BytePlus asset-library calls (not generation; exempt from the paid guard)."""
    paid_guard_exempt = True
    ACTIONS = {
        'CreateAssetGroup': {'Name', 'Description', 'GroupType', 'ProjectName'},
        'GetAssetGroup': {'Id', 'ProjectName'},
        'ListAssetGroups': {'Filter', 'MaxResults', 'NextToken', 'ProjectName'},
        'DeleteAssetGroup': {'Id', 'ProjectName'},
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
    from apps.integrations.byteplus import BytePlusClient, config_from_env
    config = config_from_env()
    config['is_mock'] = False
    return BytePlusClient(config, transport=PoolAssetTransport(allowed_hosts={ASSET_HOST}, timeout=30))


# ---------------------------------------------------------------- settings
def setting_values():
    from apps.admin_dashboard.models import AppSetting
    from apps.admin_dashboard.views import parse
    stored = {row.key: row.value for row in AppSetting.objects.filter(key__in=list(SETTINGS))}
    return {key: parse(stored.get(key), definition) for key, definition in SETTINGS.items()}


def effective_capacity(values, pool, now):
    """Slots we may fill: the admin capacity, capped by what BytePlus last accepted. That cap can be 0 (the quota is used up
    outside the pool). Once QUOTA_BACKOFF_MS has passed since the last refusal one more registration is allowed as a probe."""
    capacity = values['portraitPoolCapacity']
    if pool.observed_capacity is not None:
        observed = max(0, pool.observed_capacity)
        if pool.last_quota_error_at is not None and now - pool.last_quota_error_at >= QUOTA_BACKOFF_MS:
            observed += 1
        capacity = min(capacity, observed)
    return capacity


# ---------------------------------------------------------------- face scan
def content_sha256(data):
    return hashlib.sha256(data).hexdigest()


def scan_reference(data, *, scanner=None, now=None):
    """Cached face scan for these exact bytes."""
    sha = content_sha256(data)
    cached = ReferenceFaceScan.objects.filter(pk=sha).first()
    if cached and cached.forced == REFUSED:      # BytePlus refused to register it as a portrait: send it inline, whatever the detector says
        return sha, False
    if cached and cached.forced:        # an upload or a provider rejection said so: a face, whatever the detector version
        return sha, True
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


def force_face(sha, forced, now=None):
    """Record that these exact bytes are a face (a Gallery upload or a provider rejection), whatever the detector says.
    Returns whether the image now counts as a face. A refused-asset marker is not overturned by a provider rejection (that
    would loop forever: refused as an asset, rejected inline, learned as a face, refused as an asset...); only an explicit
    Gallery upload replaces it."""
    now = now or now_ms()
    row, created = ReferenceFaceScan.objects.get_or_create(pk=sha, defaults={'has_face': True, 'faces': 1, 'detector_version': 'forced',
                                                                             'error': None, 'scanned_at': now, 'forced': forced})
    if created:
        return True
    if row.forced == REFUSED and forced != 'upload':
        return False
    ReferenceFaceScan.objects.filter(pk=sha).update(has_face=True, forced=forced if row.forced == REFUSED else row.forced or forced, scanned_at=now)
    return True


def refuse_as_asset(sha, now=None):
    """BytePlus refused to register this image as a portrait. When only our detector thought it a face (not an upload,
    not learned from a provider rejection) it is sent inline from now on."""
    updated = ReferenceFaceScan.objects.filter(pk=sha, forced__isnull=True).update(has_face=False, forced=REFUSED, scanned_at=now or now_ms())
    return bool(updated)


def _claimants():
    """Under the pool lock: everyone waiting for a slot, oldest first, as [(waiting_since, id)]: queued generations that
    last found the pool full, and QUEUED Gallery uploads."""
    from apps.generation.models import Generation
    queued = Generation.objects.filter(status='queued').values('id')
    rows = [(row.queued_at or row.started_at, str(row.generation_id)) for row in
            ManagedPortraitWait.objects.filter(reason='portrait_pool_full', generation_id__in=queued)]
    rows += [(row.created_at, str(row.id)) for row in ManagedPortraitAsset.objects.filter(status='QUEUED')]
    return sorted(rows)


def _first_in_line(claimant, since):
    return not any(other < (since, str(claimant)) for other in _claimants() if other[1] != str(claimant))


def _eviction_unresolved():
    """A delete we started (an eviction, an expiry, a Gallery delete) that BytePlus has not confirmed: DELETING, or UNCERTAIN after a failed call."""
    return ManagedPortraitAsset.objects.filter(status__in=('DELETING', 'UNCERTAIN'), receipt__delete__state='CLAIMED').exists()


def _take_slot(values, pool, now):
    """Under the pool lock: 'free' when a slot is free, an ACTIVE unpinned victim (now DELETING) when one can be evicted, else None.
    No second eviction starts while an earlier delete is unresolved: its slot is about to free (or the delete keeps failing),
    and evicting more would only empty the pool without ever making room."""
    if ManagedPortraitAsset.objects.filter(status__in=LIVE).count() < effective_capacity(values, pool, now):
        return 'free'
    if _eviction_unresolved():
        return None
    pinned = ManagedPortraitPin.objects.values('asset_id')
    victim = (ManagedPortraitAsset.objects.select_for_update().filter(status='ACTIVE').exclude(id__in=pinned)
              .order_by('last_used_at', 'created_at').first())
    if victim is None:
        return None
    victim.status, victim.updated_at = 'DELETING', now
    victim.receipt = {**victim.receipt, 'delete': {'state': 'CLAIMED', 'reason': 'evicted', 'at': now}}
    victim.save(update_fields=['status', 'updated_at', 'receipt'])
    return victim


def has_room():
    """Read-only: whether a new portrait could get a slot now (a free slot, or an unused one to evict)."""
    pool = ManagedPortraitPool.objects.filter(pk=1).first() or ManagedPortraitPool(id=1, updated_at=0)
    if ManagedPortraitAsset.objects.filter(status__in=LIVE).count() < effective_capacity(setting_values(), pool, now_ms()):
        return True
    pinned = ManagedPortraitPin.objects.values('asset_id')
    return not _eviction_unresolved() and ManagedPortraitAsset.objects.filter(status='ACTIVE').exclude(id__in=pinned).exists()


def _claim(sha, source_key, generation_id, user_id, now):
    """Under the pool lock: decide what this reference needs. Returns (outcome_or_None, asset, action)."""
    values = setting_values()
    with transaction.atomic():
        _locked()
        pool = _pool()
        queued = ManagedPortraitAsset.objects.filter(content_sha256=sha, status='QUEUED').first()
        if queued is not None:       # a Gallery upload of this very image is waiting its turn; hold it and wait for it
            pin(generation_id, queued)
            _unclaim(generation_id)
            return wait('portrait_queued', 3000), queued, None
        asset = ManagedPortraitAsset.objects.filter(content_sha256=sha, status__in=LIVE).first()
        if asset is not None:
            pin(generation_id, asset)
            _unclaim(generation_id)
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
        waiting = ManagedPortraitWait.objects.filter(generation_id=generation_id, reason='portrait_pool_full').first()
        since = (waiting.queued_at or waiting.started_at) if waiting else now     # only time spent waiting for a slot counts, not for processing
        paused = pause_remaining(now)
        if paused:      # everyone keeps their place in the queue while BytePlus's write limit recovers
            return _pool_full(generation_id, now, min(paused, 15000), 'portrait_paused'), None, None
        if not _first_in_line(generation_id, since):
            return _pool_full(generation_id, now, 5000), None, None
        slot = _take_slot(values, pool, now)
        if slot is None:
            return _pool_full(generation_id, now, 15000), None, None
        if slot != 'free':
            return wait('portrait_evicting', 1000), slot, 'delete'
        _unclaim(generation_id)
        asset = ManagedPortraitAsset.objects.create(id=uuid.uuid4(), content_sha256=sha, source_key=source_key, status='REGISTERING',
            receipt={'version': 1, 'state': 'CLAIMED', 'attempt': str(uuid.uuid4()), 'registered_at': now}, created_by_id=user_id,
            created_at=now, updated_at=now, last_used_at=now)
        pin(generation_id, asset)
        return None, asset, 'register'


def throttled(error):
    return error.status == 429 or bool(THROTTLED.search(str(error.code)))


def content_refusal(error):
    """A 4xx whose code says BytePlus judged the image (moderation, invalid parameter or image), and not a limit."""
    return isinstance(error.status, int) and 400 <= error.status < 500 and not throttled(error) and bool(CONTENT_REFUSAL.search(str(error.code)))


def _throttle_record(asset, now):
    """{'first_at', 'last_at', 'count'} of the throttling this image has met without a break (an earlier row of the same
    image counts: a generation claims a new row each time)."""
    record = (asset.receipt or {}).get('throttle')
    if not record:
        prior = (ManagedPortraitAsset.objects.filter(content_sha256=asset.content_sha256, status__in=('QUEUED', 'FAILED'),
                 receipt__throttle__last_at__gte=now - THROTTLE_GIVE_UP_MS).exclude(pk=asset.pk).order_by('-updated_at').first())
        record = prior.receipt['throttle'] if prior else None
    return {'first_at': record['first_at'] if record else now, 'last_at': now, 'count': (record['count'] if record else 0) + 1}


def pause_remaining(now):
    """Milliseconds left of a registration pause after a BytePlus write limit, else 0."""
    from apps.admin_dashboard.models import AppSetting
    raw = AppSetting.objects.filter(key=PAUSE_KEY).values_list('value', flat=True).first()
    try:
        return max(0, int(raw) - now) if raw else 0
    except ValueError:
        return 0


def _pause(now):
    from apps.admin_dashboard.models import AppSetting
    AppSetting.objects.update_or_create(key=PAUSE_KEY, defaults={'value': str(now + PAUSE_MS), 'updated_at': now})


def _pool_full(generation_id, now, delay_ms, reason='portrait_pool_full'):
    """This generation waits for a slot and is now in the queue (kept across passes so it keeps its place)."""
    row, _ = ManagedPortraitWait.objects.get_or_create(generation_id=generation_id,
                                                       defaults={'started_at': now, 'reason': 'portrait_pool_full', 'queued_at': now})
    if row.reason != 'portrait_pool_full':      # it waited for something else until now (started_at keeps the overall wait limit)
        ManagedPortraitWait.objects.filter(generation_id=generation_id).update(reason='portrait_pool_full', queued_at=now)
    return wait(reason, delay_ms)


def _unclaim(generation_id):
    """The generation no longer waits for a slot (it got one, or shares an asset): it leaves the queue."""
    ManagedPortraitWait.objects.filter(generation_id=generation_id, reason='portrait_pool_full').update(reason='portrait_registering', queued_at=None)


def claim_upload(asset_id, now=None):
    """Under the pool lock: give a QUEUED Gallery upload a slot if it is first in line. Returns (asset, action) or None.
    The upload is pinned by its own id until it is ACTIVE so it cannot be evicted while registering."""
    values, now = setting_values(), now or now_ms()
    with transaction.atomic():
        _locked()
        pool = _pool()
        asset = ManagedPortraitAsset.objects.select_for_update().filter(pk=asset_id, status='QUEUED').first()
        if asset is None or not _first_in_line(asset.id, asset.created_at) or pause_remaining(now):
            return None
        slot = _take_slot(values, pool, now)
        if slot is None:
            return None
        if slot != 'free':
            return slot, 'delete'
        asset.status, asset.updated_at, asset.last_used_at = 'REGISTERING', now, now
        asset.receipt = {'version': 1, 'state': 'CLAIMED', 'attempt': str(uuid.uuid4()), 'registered_at': now,
                         **({'throttle': asset.receipt['throttle']} if (asset.receipt or {}).get('throttle') else {})}   # the processing clock starts here, not at upload
        asset.save(update_fields=['status', 'updated_at', 'last_used_at', 'receipt'])
        pin(asset.id, asset)
        return asset, 'register'


def _finish(asset, **fields):
    with transaction.atomic():
        _locked()
        row = ManagedPortraitAsset.objects.select_for_update().get(pk=asset.pk)
        for key, value in fields.items():
            setattr(row, key, value)
        row.updated_at = now_ms()
        row.save()
        return row


def _pool_group(client):
    """The oldest BytePlus group named POOL_GROUP_NAME (ties broken by id so every process picks the same one), or None."""
    found, token = [], None
    for _ in range(50):
        page = client.list_asset_groups(name=POOL_GROUP_NAME, max_results=50, next_token=token)
        found += [item for item in page.get('Items') or []      # a group BytePlus reports as Deleted is gone, whatever its name
                  if item.get('Name') == POOL_GROUP_NAME and item.get('Id') and item.get('Status') != 'Deleted']
        token = page.get('NextToken')
        if not token:
            break
    return min(found, key=lambda item: (str(item.get('CreateTime') or ''), item['Id']))['Id'] if found else None


def ensure_group(client):
    """The pool's one group: the stored id, else the group already named POOL_GROUP_NAME at BytePlus, else a new one."""
    with transaction.atomic():
        _locked()
        pool = _pool()
        if pool.byteplus_group_id:
            return pool.byteplus_group_id
    chosen = _pool_group(client)
    if chosen is None:
        created = client.create_asset_group(POOL_GROUP_NAME, 'Automatic portrait pool (expires after use)')['Id']
        # Another process may have created it at the same moment: keep the oldest group, drop our own empty duplicate.
        chosen = _pool_group(client) or created
        if chosen != created:
            try:
                client.delete_asset_group(created)
            except Exception:
                pass
    with transaction.atomic():
        _locked()
        pool = _pool()
        if not pool.byteplus_group_id:
            pool.byteplus_group_id, pool.updated_at = chosen, now_ms()
            pool.save(update_fields=['byteplus_group_id', 'updated_at'])
        return pool.byteplus_group_id


def forget_group(group_id):
    with transaction.atomic():
        _locked()
        ManagedPortraitPool.objects.filter(pk=1, byteplus_group_id=group_id).update(byteplus_group_id=None, updated_at=now_ms())


def remote_delete(asset, client):
    """Delete remotely with a verified outcome. Returns True when the slot is free."""
    from apps.integrations.byteplus import BytePlusAssetError
    if not asset.byteplus_asset_id:
        _finish(asset, status='DELETED', deleted_at=now_ms())
        return True
    try:
        client.delete_asset(asset.byteplus_asset_id)
    except BytePlusAssetError as error:
        if error.code in ('NotFound.asset_id', 'NotFound'):
            _finish(asset, status='DELETED', deleted_at=now_ms())
            return True
        _finish(asset, status='UNCERTAIN', error_code=str(error.code)[:100], receipt=_last_error(asset, error))
        return False
    except Exception:
        _finish(asset, status='UNCERTAIN', error_code='delete_unverified')
        return False
    _finish(asset, status='DELETED', deleted_at=now_ms())
    return True


def _learn_capacity():
    """BytePlus accepted a registration beyond the capacity it last refused at (a probe after the backoff): the quota has grown."""
    with transaction.atomic():
        _locked()
        pool = _pool()
        live = ManagedPortraitAsset.objects.filter(status__in=LIVE).count()
        if pool.observed_capacity is not None and live > pool.observed_capacity:
            pool.observed_capacity, pool.updated_at = live, now_ms()
            pool.save(update_fields=['observed_capacity', 'updated_at'])


def _register(asset, data, storage, client, user_id, requeue=False):
    from apps.integrations.byteplus import BytePlusAssetError
    key = asset.source_key
    try:
        derived = bounded_copy(data)
    except Exception:
        derived = None
    if derived is not None:
        key = f'portrait-pool/{asset.content_sha256}.jpg'
        try:
            storage.write_private_buffer(derived, key, 'image/jpeg')
        except Exception:       # nothing was sent to BytePlus: settle the row so it does not sit REGISTERING with its pin
            _finish(asset, status='FAILED', error_code='storage_unwritable')
            return failed(PORTRAIT_UNPREPARED + NOT_CHARGED, 'portrait_rejected')
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
                pool.observed_capacity = ManagedPortraitAsset.objects.filter(status__in=LIVE).exclude(pk=asset.pk).count()
                pool.last_quota_error_at = pool.updated_at = now_ms()
                pool.save(update_fields=['observed_capacity', 'last_quota_error_at', 'updated_at'])
            # A Gallery upload keeps its place in the queue instead of failing; a generation retries with a fresh claim.
            _finish(asset, status='QUEUED' if requeue else 'FAILED', error_code='QuotaSharedPoolExceeded', receipt=_last_error(asset, error))
            return wait('portrait_pool_full', 5000)
        if throttled(error):
            # The asset API's write limit: nothing was created, the image was not judged. Pause new registrations
            # for everyone, and retry this one later (an upload keeps its place; a generation claims again).
            # A limit that outlasts THROTTLE_GIVE_UP_MS is a per-image error in disguise: stop requeueing and pausing for it.
            now = now_ms()
            record = _throttle_record(asset, now)
            if now - record['first_at'] > THROTTLE_GIVE_UP_MS:
                _finish(asset, status='FAILED', error_code='throttled', receipt=_last_error(asset, error, throttle=record))
                return failed(PORTRAIT_UNAVAILABLE + NOT_CHARGED + ' Retry to try again.', 'portrait_rejected', error.provider_error)
            _pause(now)
            _finish(asset, status='QUEUED' if requeue else 'FAILED', error_code='throttled', receipt=_last_error(asset, error, throttle=record))
            return wait('portrait_paused', 15000)
        if content_refusal(error):
            _finish(asset, status='FAILED', error_code=str(error.code)[:100], receipt=_last_error(asset, error))
            if refuse_as_asset(asset.content_sha256):       # a guess of the detector: the job goes on with the image inline
                return wait('portrait_registering', 1000)
            message = PORTRAIT_REFUSED if error.code == 'moderation_rejected' else PORTRAIT_UNPREPARED
            return failed(message + NOT_CHARGED, 'portrait_rejected', error.provider_error)
        if isinstance(error.status, int) and 400 <= error.status < 500 and error.status not in (408, 409):
            # Not about the image and not a limit (credentials, a changed API): nothing was created and retrying blindly would
            # block the queue, so it fails now (not refused: a later Retry or upload may succeed). No pause, no requeue.
            _finish(asset, status='FAILED', error_code=str(error.code)[:100], receipt=_last_error(asset, error))
            return failed(PORTRAIT_UNAVAILABLE + NOT_CHARGED + ' Retry to try again.', 'portrait_rejected', error.provider_error)
        # 5xx, timeouts, network: the call may have created the asset, so reconcile by name later.
        _finish(asset, status='UNCERTAIN', error_code=str(error.code)[:100], receipt=_last_error(asset, error))
        return wait('portrait_uncertain', 10000)
    except Exception:
        _finish(asset, status='UNCERTAIN', error_code='create_unverified')
        return wait('portrait_uncertain', 10000)
    identifier = response.get('Id') if isinstance(response, dict) else None
    if not identifier:
        _finish(asset, status='UNCERTAIN', error_code='create_no_id')
        return wait('portrait_uncertain', 10000)
    _learn_capacity()
    active = response.get('Status') == 'Active'
    row = _finish(asset, byteplus_asset_id=identifier, status='ACTIVE' if active else 'PROCESSING',
                  receipt={**{k: v for k, v in asset.receipt.items() if k != 'throttle'}, 'state': 'ACKNOWLEDGED', 'remote_id': identifier, 'verified_at': now_ms()})
    if active:
        with transaction.atomic():
            _locked()
            _activated(ManagedPortraitAsset.objects.select_for_update().get(pk=row.pk), setting_values(), now_ms())
        return ready(identifier)
    return wait('portrait_processing', 3000)


def _poll(asset, client):
    from apps.integrations.byteplus import BytePlusAssetError
    try:
        remote = client.get_asset(asset.byteplus_asset_id)
    except BytePlusAssetError as error:
        if error.code in ('NotFound.asset_id', 'NotFound'):
            _finish(asset, status='FAILED', error_code='missing_after_create', receipt=_last_error(asset, error))
            return failed(PORTRAIT_MISSING, 'portrait_missing', error.provider_error)
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
    registered_at = int((asset.receipt or {}).get('registered_at') or asset.created_at)
    if status == 'Failed' or now_ms() - registered_at > PROCESSING_LIMIT_MS:
        code = 'processing_failed' if status == 'Failed' else 'processing_timeout'
        # Only a row that is still PROCESSING is condemned, and never one a generation holds: that generation fails
        # cleanly (not charged) and releases its pin, then the next poll (janitor or upload pass) deletes the asset.
        with transaction.atomic():
            _locked()
            row = ManagedPortraitAsset.objects.select_for_update().get(pk=asset.pk)
            if row.status != 'PROCESSING':
                return wait('portrait_registering', 1000)       # someone else already settled it
            held = ManagedPortraitPin.objects.filter(asset=row).exclude(generation_id=row.id).exists()
            if not held:
                row.status, row.error_code, row.updated_at = 'DELETING', code, now_ms()
                row.receipt = {**(row.receipt or {}), 'delete': {'state': 'CLAIMED', 'reason': code, 'at': row.updated_at}}
                row.save(update_fields=['status', 'error_code', 'updated_at', 'receipt'])
        if not held and remote_delete(row, client) and row.origin == 'upload':
            _finish(row, status='FAILED', deleted_at=None)      # an upload stays visible as "can't be used"
        from apps.generation import provider_errors
        detail = provider_errors.capture('byteplus-assets', phase='GetAsset', code=code, message='Asset status: ' + (status or 'unknown'),
                                         task_id=asset.byteplus_asset_id, source='veevee',
                                         body=json.dumps({key: value for key, value in (remote or {}).items() if key != 'URL'}, default=str))
        return failed(PORTRAIT_UNPREPARED + NOT_CHARGED, 'portrait_rejected', detail)
    return wait('portrait_processing', 3000)


def _verify(asset, client):
    """An ACTIVE row must still exist at BytePlus (it can be removed outside Veevee). Returns ready/None(gone)/wait."""
    from apps.integrations.byteplus import BytePlusAssetError
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
def _mark_deleting(asset, reason, now):
    asset.status, asset.updated_at = 'DELETING', now
    asset.receipt = {**asset.receipt, 'delete': {'state': 'CLAIMED', 'reason': reason, 'at': now}}
    asset.save(update_fields=['status', 'updated_at', 'receipt'])


def release_upload_pins():
    """An upload is pinned by its own id while it registers; once it is settled (ACTIVE, FAILED, gone) the pin goes."""
    settled = ManagedPortraitAsset.objects.exclude(status__in=('REGISTERING', 'PROCESSING', 'UNCERTAIN')).values('id')
    return ManagedPortraitPin.objects.filter(generation_id=F('asset_id'), asset_id__in=settled).delete()[0]


def janitor(*, client=None, now=None):
    """Expire unused assets, release stale pins, recover stuck rows, reconcile uncertain ones. Safe to run concurrently."""
    from apps.generation.models import Generation
    client = client or default_client()
    now = now or now_ms()
    report = {'pins_released': 0, 'expired': 0, 'reconciled': 0, 'recovered': 0}
    terminal = Generation.objects.filter(id__in=ManagedPortraitPin.objects.values('generation_id')).exclude(status__in=('queued', 'running'))
    report['pins_released'] = ManagedPortraitPin.objects.filter(generation_id__in=terminal.values('id')).delete()[0]
    orphan = ManagedPortraitPin.objects.exclude(generation_id__in=Generation.objects.values('id')).exclude(generation_id=F('asset_id'))
    report['pins_released'] += orphan.delete()[0] + release_upload_pins()
    # A wait row of a generation that is no longer queued must not hold a place in the queue.
    ManagedPortraitWait.objects.exclude(generation_id__in=Generation.objects.filter(status='queued').values('id')).delete()
    with transaction.atomic():
        _locked()
        pinned = ManagedPortraitPin.objects.values('asset_id')
        # Expired, or deleted from the Gallery while a generation held it (hidden) and nothing holds it now.
        expired = list(ManagedPortraitAsset.objects.select_for_update().filter(status='ACTIVE').exclude(id__in=pinned)
                       .filter(Q(expires_at__lt=now) | Q(hidden_at__isnull=False)))
        for asset in expired:
            _mark_deleting(asset, 'expired' if asset.hidden_at is None else 'user', now)
        # Nothing remote to delete for a hidden row that never became an asset.
        (ManagedPortraitAsset.objects.filter(status__in=('QUEUED', 'FAILED'), hidden_at__isnull=False).exclude(id__in=pinned)
         .update(status='DELETED', deleted_at=now, updated_at=now))
        (ManagedPortraitAsset.objects.filter(status='REGISTERING', updated_at__lt=now - REGISTERING_STALE_MS)
         .update(status='UNCERTAIN', updated_at=now))
    for asset in expired:
        report['expired'] += 1 if remote_delete(asset, client) else 0
    report['recovered'] = recover_deletes(client, now=now, stale_ms=DELETING_STALE_MS) + recover_processing(client)
    stale = ManagedPortraitAsset.objects.filter(status__in=('UNCERTAIN',)).order_by('updated_at')[:20]
    for asset in stale:
        report['reconciled'] += 1 if _reconcile(asset, client) else 0
    return report


def recover_deletes(client, *, now=None, stale_ms=0, limit=20):
    """Finish remote deletes nobody completed: Gallery deletes (done soon after the request) and rows stuck in DELETING."""
    now = now or now_ms()
    rows = ManagedPortraitAsset.objects.filter(status='DELETING').filter(
        Q(receipt__delete__reason='user') | Q(updated_at__lt=now - stale_ms)).order_by('updated_at')[:limit]
    return sum(1 for asset in rows if remote_delete(asset, client))


def recover_processing(client, limit=20):
    """Poll rows left in PROCESSING (their generation may be gone) so they become ACTIVE, or fail and free their slot."""
    count = 0
    for asset in ManagedPortraitAsset.objects.filter(status='PROCESSING').order_by('updated_at')[:limit]:
        if asset.byteplus_asset_id:
            _poll(asset, client)
            count += 1
    return count


def process_uploads(*, client=None, storage=None, now=None, limit=UPLOADS_PER_PASS, budget_s=UPLOAD_PASS_SECONDS, clock=time.monotonic):
    """Scheduler step (every few seconds): register Gallery uploads oldest first, behind everyone who was waiting
    longer, one after another until `limit` or the time budget is used. Never holds the pool lock on the network."""
    client = client or default_client()
    report = {'registered': 0, 'polled': 0, 'deleted': 0}
    deadline = clock() + budget_s
    while True:
        step = _process_upload_once(client=client, storage=storage, now=now)
        for key in report:
            report[key] += step[key]
        if not step['registered'] or step.get('retry_later') or report['registered'] >= limit or clock() >= deadline:
            return report


def _process_upload_once(*, client, storage=None, now=None):
    report = {'registered': 0, 'polled': 0, 'deleted': 0}
    report['deleted'] = recover_deletes(client, now=now, stale_ms=DELETING_STALE_MS, limit=5)
    for asset in ManagedPortraitAsset.objects.filter(status='PROCESSING', origin='upload').order_by('created_at')[:5]:
        if asset.byteplus_asset_id:
            _poll(asset, client)
            report['polled'] += 1
    release_upload_pins()
    if ManagedPortraitAsset.objects.filter(status='REGISTERING', origin='upload', updated_at__gte=(now or now_ms()) - REGISTERING_STALE_MS).exists():
        return report
    first = ManagedPortraitAsset.objects.filter(status='QUEUED').order_by('created_at', 'id').first()
    if first is None:
        return report
    claimed = claim_upload(first.id, now)
    if claimed is None:
        return report
    asset, action = claimed
    if action == 'delete':
        remote_delete(asset, client)
        report['deleted'] += 1
        return report
    from apps.media.storage import get_storage
    storage = storage or get_storage()
    try:
        data = storage.read(asset.source_key)
    except Exception:
        _finish(asset, status='FAILED', error_code='source_unreadable')
        release_upload_pins()
        return report
    outcome = _register(asset, data, storage, client, asset.created_by_id, requeue=True)
    report['registered'] = 1
    if outcome.kind == 'wait' and outcome.reason in ('portrait_pool_full', 'portrait_paused'):
        report['retry_later'] = 1       # quota or rate limit: the next pass tries again, not this one
    release_upload_pins()
    return report


def _reconcile(asset, client):
    """Resolve an UNCERTAIN row against BytePlus by our deterministic asset name."""
    from apps.integrations.byteplus import BytePlusAssetError
    try:
        group = ManagedPortraitPool.objects.filter(pk=1).values_list('byteplus_group_id', flat=True).first()
        name = NAME_PREFIX + asset.content_sha256[:40]
        match, token = None, None
        for _ in range(50):         # the group can hold more assets than one page
            listing = client.list_assets(group_ids=[group] if group else None, max_results=100, next_token=token)
            match = next((item for item in listing.get('Items', []) if item.get('Name') == name or (
                asset.byteplus_asset_id and item.get('Id') == asset.byteplus_asset_id)), None)
            token = listing.get('NextToken')
            if match or not token:
                break
    except BytePlusAssetError:
        return False
    except Exception:
        return False
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
