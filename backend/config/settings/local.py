"""Local stack only (local/compose.yaml): production settings plus an http://localhost frontend.

Identical to config.settings.production except that browser origins may also be
plain-HTTP localhost (the Next.js dev server). Never set in a deployed service.
"""
from urllib.parse import urlsplit

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import ALLOWED_HOSTS, VEEVEE_BROWSER_ORIGINS

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'

if not ALLOWED_HOSTS or '*' in ALLOWED_HOSTS:
    raise ImproperlyConfigured('Local stack requires explicit Django allowed hosts')
for _origin in VEEVEE_BROWSER_ORIGINS:
    _parsed = urlsplit(_origin)
    if not (_parsed.scheme == 'https' or (_parsed.scheme == 'http' and _parsed.hostname in ('localhost', '127.0.0.1'))):
        raise ImproperlyConfigured('Local stack allows https origins or http://localhost only')
