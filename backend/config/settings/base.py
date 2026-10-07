"""Explicit environment only: never load the credentialed checkout's dotenv files."""
import os
from urllib.parse import urlsplit, unquote, parse_qsl
from django.core.exceptions import ImproperlyConfigured

SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
DEBUG = False
ALLOWED_HOSTS = [host.strip() for host in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if host.strip()]
INSTALLED_APPS = ['rest_framework', 'apps.common', 'apps.authentication', 'apps.admin_dashboard']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'apps.common.middleware.RequestLogMiddleware']
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
APPEND_SLASH = False
USE_TZ = True
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
REST_FRAMEWORK = {'UNAUTHENTICATED_USER': None, 'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer']}
u = urlsplit(os.environ['DATABASE_URL'])
if u.scheme not in ('postgres', 'postgresql') or not u.hostname or not u.path.strip('/'):
    raise ImproperlyConfigured('An explicit PostgreSQL target is required')
DATABASES = {'default': {'ENGINE': 'django.db.backends.postgresql', 'NAME': unquote(u.path[1:]), 'USER': unquote(u.username or ''), 'PASSWORD': unquote(u.password or ''), 'HOST': u.hostname, 'PORT': u.port or 5432, 'CONN_MAX_AGE': 60, 'OPTIONS': {'connect_timeout': 5}}}

AUTH_SECRET = os.environ['AUTH_SECRET']
SESSION_COOKIE_SECURE = True

# Preserve reviewed libpq transport options instead of silently discarding TLS.
DB_URL_OPTIONS = dict(parse_qsl(u.query))
SUPPORTED_DB_OPTIONS = {'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'application_name'}
if set(DB_URL_OPTIONS) - SUPPORTED_DB_OPTIONS:
    raise ImproperlyConfigured('Unsupported database URL options; review transport configuration')
DATABASES['default']['OPTIONS'].update(DB_URL_OPTIONS)
LOGGING = {
    'version': 1, 'disable_existing_loggers': False,
    'handlers': {'structured_console': {'class': 'logging.StreamHandler', 'stream': 'ext://sys.stdout'}},
    'loggers': {'veevee.requests': {'handlers': ['structured_console'], 'level': 'INFO', 'propagate': False}},
}
