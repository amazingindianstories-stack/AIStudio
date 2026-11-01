"""Browser Web Push for the notification bell.

The push services are not ours to run: a browser subscribes, we keep its endpoint, and a scheduler slot sends
each recipient one empty VAPID-signed push per batch of new notifications. The service worker answers the push
by fetching the newest unread notification, so no message content ever passes through a third-party push
service. VAPID keys come from the environment (``VEEVEE_WEB_PUSH_PUBLIC_KEY`` and ``VEEVEE_WEB_PUSH_PRIVATE_KEY``,
unpadded base64url; ``VEEVEE_WEB_PUSH_SUBJECT`` a mailto: or https: contact). Without them the feature is off.
"""
import base64
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
import requests
from .collab_models import Notification, PushSubscription
from .services import now_ms

logger = logging.getLogger('veevee.push')
BATCH_WINDOW_MS = 10 * 60 * 1000
MAX_ENDPOINT = 2048
MAX_SENDS_PER_TICK = 100
SEND_WORKERS = 16
# Only the browsers' own push services: a subscription is user input and this server will POST to it.
PUSH_HOST_SUFFIXES = ('.googleapis.com', '.mozilla.com', '.mozaws.net', '.push.apple.com', '.notify.windows.com')


def _b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b'=').decode()


def _unb64(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))


def config(env=None):
    """(public key, private key, subject) when Web Push is configured, else None; read at call time."""
    env = os.environ if env is None else env
    public, private = env.get('VEEVEE_WEB_PUSH_PUBLIC_KEY', '').strip(), env.get('VEEVEE_WEB_PUSH_PRIVATE_KEY', '').strip()
    subject = env.get('VEEVEE_WEB_PUSH_SUBJECT', '').strip()
    if not (public and private and subject.startswith(('mailto:', 'https://'))):
        return None
    return public, private, subject


def allowed_endpoint(endpoint):
    if not isinstance(endpoint, str) or len(endpoint) > MAX_ENDPOINT:
        return False
    parts = urlsplit(endpoint)
    host = parts.hostname or ''
    return parts.scheme == 'https' and parts.port in (None, 443) and not parts.username and \
        any(('.' + host).endswith(suffix) for suffix in PUSH_HOST_SUFFIXES)


def vapid_headers(endpoint, public, private, subject, now=None):
    now = int(time.time()) if now is None else now
    parts = urlsplit(endpoint)
    segments = [_b64(json.dumps(part, separators=(',', ':')).encode()) for part in
                ({'typ': 'JWT', 'alg': 'ES256'}, {'aud': f'{parts.scheme}://{parts.netloc}', 'exp': now + 12 * 3600, 'sub': subject})]
    signing = '.'.join(segments).encode()
    key = ec.derive_private_key(int.from_bytes(_unb64(private), 'big'), ec.SECP256R1())
    r, s = decode_dss_signature(key.sign(signing, ec.ECDSA(hashes.SHA256())))
    token = signing.decode() + '.' + _b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
    return {'Authorization': f'vapid t={token}, k={public}', 'TTL': '3600', 'Urgency': 'normal', 'Content-Length': '0'}


def status(user):
    return {'enabled': config() is not None, 'publicKey': config()[0] if config() else None,
            'subscribed': PushSubscription.objects.filter(user_id=user.id).exists()}


def subscribe(user, endpoint):
    if not allowed_endpoint(endpoint):
        raise ValueError('Invalid push endpoint.')
    PushSubscription.objects.update_or_create(endpoint=endpoint, defaults={'user_id': user.id, 'created_at': now_ms()})


def unsubscribe(user, endpoint=None):
    rows = PushSubscription.objects.filter(user_id=user.id)
    if isinstance(endpoint, str):
        rows = rows.filter(endpoint=endpoint)
    rows.delete()


def send_pending(now=None, post=None):
    """Scheduler job: one empty push per user with notifications not yet pushed; unusable subscriptions are dropped.

    Sends run concurrently and a tick handles at most MAX_SENDS_PER_TICK subscriptions, so a slow push service or an
    @team mention cannot hold the scheduler loop; users past the cap stay pending for the next tick."""
    settings = config()
    if settings is None:
        return {'ok': True, 'enabled': False}
    now = now_ms() if now is None else now
    post = post or (lambda endpoint, headers: requests.post(endpoint, headers=headers, timeout=(2, 3), allow_redirects=False))
    pending = Notification.objects.filter(pushed_at__isnull=True, created_at__gte=now - BATCH_WINDOW_MS)
    users = set(pending.values_list('user_id', flat=True)[:500])
    subscriptions = list(PushSubscription.objects.filter(user_id__in=users).order_by('user_id', 'pk')[:MAX_SENDS_PER_TICK])
    sent = dropped = 0
    usable = []
    for subscription in subscriptions:
        if allowed_endpoint(subscription.endpoint):
            usable.append(subscription)
        else:
            subscription.delete()
            dropped += 1

    def deliver(subscription):
        try:
            return post(subscription.endpoint, vapid_headers(subscription.endpoint, *settings))
        except requests.RequestException:
            return None

    with ThreadPoolExecutor(max_workers=SEND_WORKERS) as pool:
        responses = list(pool.map(deliver, usable))
    for subscription, response in zip(usable, responses):
        if response is None:
            continue
        if response.status_code in (404, 410):
            subscription.delete()
            dropped += 1
        elif response.status_code < 300:
            sent += 1
        else:
            logger.warning('push refused status=%s', response.status_code)
    # Users whose subscriptions did not all fit in this tick keep their notifications pending.
    deferred = set(PushSubscription.objects.filter(user_id__in=users).exclude(pk__in=[s.pk for s in subscriptions]).values_list('user_id', flat=True))
    done = users - deferred
    Notification.objects.filter(pk__in=list(pending.filter(user_id__in=done).values_list('pk', flat=True)[:5000])).update(pushed_at=now)
    return {'ok': True, 'enabled': True, 'sent': sent, 'dropped': dropped}
