import hmac
import re
from django.conf import settings


def equal(actual, expected):
    return bool(expected) and hmac.compare_digest(actual.encode('utf-8'), expected.encode('utf-8'))


def worker_authorized(request):
    match = re.fullmatch(r'Bearer\s+(.+)', request.headers.get('Authorization', ''), re.IGNORECASE)
    return bool(match) and equal(match[1], getattr(settings, 'DEPTH_WORKER_TOKEN', ''))


def cron_authorized(request):
    secret = getattr(settings, 'CRON_SECRET', '')
    return bool(secret) and equal(request.headers.get('Authorization', ''), f'Bearer {secret}')
