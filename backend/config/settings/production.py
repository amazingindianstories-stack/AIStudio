from .base import *  # noqa: F403

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'

from django.core.exceptions import ImproperlyConfigured
if not ALLOWED_HOSTS or '*' in ALLOWED_HOSTS:
    raise ImproperlyConfigured('Production requires explicit Django allowed hosts')

if not VEEVEE_BROWSER_ORIGINS or any(not value.startswith('https://') for value in VEEVEE_BROWSER_ORIGINS):
    raise ImproperlyConfigured('Production requires explicit HTTPS frontend browser origins')
