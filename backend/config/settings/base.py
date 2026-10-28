"""Explicit environment only: never load the credentialed checkout's dotenv files."""
import os
import sys
from urllib.parse import urlsplit, unquote, parse_qsl
from django.core.exceptions import ImproperlyConfigured

SECRET_KEY = os.environ['DJANGO_SECRET_KEY']
DEBUG = False
ALLOWED_HOSTS = [host.strip() for host in os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',') if host.strip()]
INSTALLED_APPS = ['rest_framework', 'apps.common', 'apps.authentication', 'apps.admin_dashboard', 'apps.library', 'apps.projects', 'apps.assets', 'apps.canvas', 'apps.agents', 'apps.generation', 'apps.workers', 'apps.exports', 'apps.media', 'apps.mcp_auth', 'apps.mcp']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'apps.common.middleware.RequestLogMiddleware', 'apps.common.middleware.LocalDataModeMiddleware', 'apps.common.origin.BrowserOriginMiddleware', 'apps.common.middleware.SessionRenewalMiddleware']

LOCAL_DATA_MODE = os.environ.get('LOCAL_DATA_MODE', 'fixtures')
if LOCAL_DATA_MODE not in ('fixtures', 'sanitized_snapshot', 'read_only_viewer'):
    raise ImproperlyConfigured('Invalid local data mode')
if LOCAL_DATA_MODE == 'read_only_viewer' and any(command in sys.argv for command in (
        'generation_worker', 'media_export_worker', 'run_scheduler', 'migrate', 'flush')):
    raise ImproperlyConfigured('Read-only viewer cannot start writers or migrations')
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'
APPEND_SLASH = False
# Permit existing 3 MiB avatars and 15 MiB audio as base64 JSON. Individual media
# and graph endpoints enforce their own decoded limits before storage.
DATA_UPLOAD_MAX_MEMORY_SIZE = 32 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 3 * 1024 * 1024
USE_TZ = True
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
REST_FRAMEWORK = {'UNAUTHENTICATED_USER': None, 'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'], 'URL_FORMAT_OVERRIDE': None}
u = urlsplit(os.environ['DATABASE_URL'])
if u.scheme not in ('postgres', 'postgresql') or not u.hostname or not u.path.strip('/'):
    raise ImproperlyConfigured('An explicit PostgreSQL target is required')
DATABASES = {'default': {'ENGINE': 'config.db.backends.postgresql', 'NAME': unquote(u.path[1:]), 'USER': unquote(u.username or ''), 'PASSWORD': unquote(u.password or ''), 'HOST': u.hostname, 'PORT': u.port or 5432, 'CONN_MAX_AGE': 60, 'OPTIONS': {'connect_timeout': 5}}}
DATABASES['default']['CONN_HEALTH_CHECKS'] = True

AUTH_SECRET = os.environ['AUTH_SECRET']
SESSION_COOKIE_SECURE = True
GENERATION_WORKER_SECRET = os.environ.get('GENERATION_WORKER_SECRET', '')
EXPORT_WORKER_SECRET = os.environ.get('EXPORT_WORKER_SECRET', '')
DEPTH_WORKER_SECRET = os.environ.get('DEPTH_WORKER_SECRET', '')
DEPTH_WORKER_TOKEN = os.environ.get('DEPTH_WORKER_TOKEN', '')
CRON_SECRET = os.environ.get('CRON_SECRET', '')
SEEDANCE_CALLBACK_SECRET = os.environ.get('SEEDANCE_CALLBACK_SECRET', '')
PUBLIC_APP_URL = os.environ.get('PUBLIC_APP_URL', os.environ.get('NEXT_PUBLIC_APP_URL', '')).rstrip('/')
GCP_MEDIA_CDN_URL = os.environ.get('GCP_MEDIA_CDN_URL', '').rstrip('/')
VEEVEE_PROVIDER_MEDIA_HOSTS = tuple(host.strip() for host in os.environ.get('VEEVEE_PROVIDER_MEDIA_HOSTS', '').split(',') if host.strip())
FFMPEG_BINARY = os.environ.get('FFMPEG_BINARY', 'ffmpeg')
AUDIO_TRANSCRIPTION_MODEL = os.environ.get('AUDIO_TRANSCRIPTION_MODEL', 'gemini-2.5-flash')
VEEVEE_AUDIO_TRANSCRIBER = 'apps.media.audio.configured_transcriber'
# Explicit backend selection; importing settings never opens storage or loads
# cloud credentials. Tests inject memory/filesystem services on disposable paths.
_media_backend = os.environ.get('VEEVEE_MEDIA_BACKEND')
_media_bucket = os.environ.get('GCP_MEDIA_BUCKET', os.environ.get('GCS_BUCKET_NAME', ''))
if _media_backend == 'filesystem':
    if not os.environ.get('VEEVEE_MEDIA_ROOT'):
        raise ImproperlyConfigured('Filesystem media requires an explicit VEEVEE_MEDIA_ROOT')
    VEEVEE_MEDIA_CONFIG = {'backend': 'filesystem', 'root': os.environ['VEEVEE_MEDIA_ROOT']}
elif _media_backend == 'gcs' or (not _media_backend and _media_bucket):
    _media_prefix = os.environ.get('VEEVEE_MEDIA_PREFIX', '')
    if _media_prefix and (len(_media_prefix) < 16 or not _media_prefix.endswith('/') or _media_prefix.startswith('/')
                          or any(part in ('.', '..') for part in _media_prefix.split('/'))):
        raise ImproperlyConfigured('VEEVEE_MEDIA_PREFIX must be a relative path of at least 16 characters ending in /')
    VEEVEE_MEDIA_CONFIG = {'backend': 'gcs', 'bucket': _media_bucket, 'prefix': _media_prefix,
        'project': os.environ.get('GCP_PROJECT_ID'), 'cdn_url': GCP_MEDIA_CDN_URL,
        'service_account_email': os.environ.get('GCP_SERVICE_ACCOUNT_EMAIL'),
        'fallback_bucket': os.environ.get('GCP_MEDIA_READ_FALLBACK_BUCKET'),
        'legacy_s3_bucket': os.environ.get('AWS_S3_BUCKET_NAME') if os.environ.get('GCS_MIGRATION_READ_FALLBACK') == '1' else None,
        'legacy_s3_region': os.environ.get('AWS_REGION', 'us-east-1')}
elif _media_backend == 's3':
    VEEVEE_MEDIA_CONFIG = {'backend': 's3', 'bucket': os.environ.get('AWS_S3_BUCKET_NAME'),
                          'region': os.environ.get('AWS_REGION', 'us-east-1')}
elif _media_backend:
    raise ImproperlyConfigured('Unsupported VEEVEE_MEDIA_BACKEND')
else:
    VEEVEE_MEDIA_CONFIG = {}

# Preserve reviewed libpq transport options instead of silently discarding TLS.
DB_URL_OPTIONS = dict(parse_qsl(u.query))
SUPPORTED_DB_OPTIONS = {'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'application_name'}
if set(DB_URL_OPTIONS) - SUPPORTED_DB_OPTIONS:
    raise ImproperlyConfigured('Unsupported database URL options; review transport configuration')
DATABASES['default']['OPTIONS'].update(DB_URL_OPTIONS)
LOGGING = {
    'version': 1, 'disable_existing_loggers': False,
    'handlers': {'structured_console': {'class': 'logging.StreamHandler', 'stream': 'ext://sys.stdout'}},
    'loggers': {'veevee.requests': {'handlers': ['structured_console'], 'level': 'INFO', 'propagate': False},
                'veevee.mcp': {'handlers': ['structured_console'], 'level': 'INFO', 'propagate': False}},
}

VEEVEE_BROWSER_ORIGINS = tuple(value.strip() for value in os.environ.get('DJANGO_BROWSER_ORIGINS','').split(',') if value.strip())
for value in VEEVEE_BROWSER_ORIGINS:
    parsed=urlsplit(value)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ImproperlyConfigured('Browser origins must be exact bare origins without credentials')


# Paid-generation guard (see apps/generation/services/paid_guard.py). JSON data,
# never code, e.g. {"approved_scope": "<UNLIMITED scope>", "unlimited_new_jobs": true}.
# An unknown scope, or a missing unlimited flag or cap, stops every component at startup.
import json as _json
_paid_guard_raw = os.environ.get('VEEVEE_PAID_GUARD', '')
VEEVEE_PAID_GUARD = None
if _paid_guard_raw:
    try:
        VEEVEE_PAID_GUARD = _json.loads(_paid_guard_raw)
    except ValueError:
        raise ImproperlyConfigured('VEEVEE_PAID_GUARD must be JSON') from None
    if not isinstance(VEEVEE_PAID_GUARD, dict) or not VEEVEE_PAID_GUARD.get('approved_scope'):
        raise ImproperlyConfigured('VEEVEE_PAID_GUARD requires an approved_scope')
    from apps.generation.services.paid_guard import validate as _validate_paid_guard
    try:
        _validate_paid_guard(VEEVEE_PAID_GUARD)
    except (KeyError, ValueError) as error:
        raise ImproperlyConfigured(f'VEEVEE_PAID_GUARD rejected: {error}') from None

# Which production process this is (api, generation, export, scheduler or mcp). The owning apps read it at
# call time to apply their component-specific policies (lease and naming namespaces, read-only pricing,
# export admission, the portrait lifecycle).
VEEVEE_RUNTIME_COMPONENT = os.environ.get('VEEVEE_RUNTIME_COMPONENT') or None
if VEEVEE_RUNTIME_COMPONENT not in (None, 'api', 'generation', 'export', 'scheduler', 'mcp'):
    raise ImproperlyConfigured('VEEVEE_RUNTIME_COMPONENT must be api, generation, export, scheduler or mcp')
# The MCP service (apps.mcp, docs/architecture/mcp-server.md): off unless '1'. Quotes are HMACs under their own
# secret; a held tool call waits at most MCP_MAX_HOLD_SECONDS (clients give up 60 s after the first byte).
VEEVEE_MCP = os.environ.get('VEEVEE_MCP') == '1'
MCP_QUOTE_SECRET = os.environ.get('MCP_QUOTE_SECRET', '')
MCP_MAX_HOLD_SECONDS = int(os.environ.get('MCP_MAX_HOLD_SECONDS', '45'))
if VEEVEE_RUNTIME_COMPONENT == 'mcp' and (not VEEVEE_MCP or len(MCP_QUOTE_SECRET) < 32 or not 1 <= MCP_MAX_HOLD_SECONDS <= 50):
    raise ImproperlyConfigured('The mcp component needs VEEVEE_MCP=1, a 32+ character MCP_QUOTE_SECRET and a 1-50 s hold')
VEEVEE_EXPORT_ADMISSION = os.environ.get('VEEVEE_EXPORT_ADMISSION') == '1'
# Magnific image/video upscaling through the gateway and paid guard (off unless '1').
VEEVEE_MAGNIFIC_UPSCALE = os.environ.get('VEEVEE_MAGNIFIC_UPSCALE') == '1'
# Paid Gemini Omni Flash 1.1 video through the paid guard (off unless '1'; switched on after live acceptance).
VEEVEE_GEMINI_OMNI = os.environ.get('VEEVEE_GEMINI_OMNI') == '1'
# Paid Kling Image 3.0 / 2.1 through the paid guard (off unless '1'; the API and generation worker both need it).
VEEVEE_KLING = os.environ.get('VEEVEE_KLING') == '1'
# Worker lease and filename-sequence namespaces (live Green state; see
# apps/common/leases.py and apps/library/services/naming.py). Empty means no
# namespace; the API process never uses them.
VEEVEE_LEASE_PREFIX = os.environ.get('VEEVEE_LEASE_PREFIX', '')
VEEVEE_NAMING_PREFIX = os.environ.get('VEEVEE_NAMING_PREFIX', '')
if VEEVEE_RUNTIME_COMPONENT in ('generation', 'export', 'scheduler'):
    if VEEVEE_LEASE_PREFIX and not (VEEVEE_LEASE_PREFIX.startswith('lease:') and VEEVEE_LEASE_PREFIX.endswith(':')):
        raise ImproperlyConfigured('Lease prefix must start with "lease:" and end with ":"')
    if VEEVEE_NAMING_PREFIX and (not VEEVEE_NAMING_PREFIX.endswith(':') or len(VEEVEE_NAMING_PREFIX) < 4):
        raise ImproperlyConfigured('Naming prefix must end with ":"')
# BytePlus portrait lifecycle (list-only sync, tombstones, create-once
# registration, remote-first delete); API process only.
VEEVEE_PORTRAIT_LIFECYCLE = os.environ.get('VEEVEE_PORTRAIT_LIFECYCLE') == '1'
# Automatic BytePlus portrait pool (face detection, expiry, eviction). Off = manual Gallery uploads.
VEEVEE_MANAGED_PORTRAITS = os.environ.get('VEEVEE_MANAGED_PORTRAITS') == '1'

# Admits OmniHuman jobs; BytePlus Vision calls sign with the existing BytePlus access key pair.
VEEVEE_OMNIHUMAN = os.environ.get('VEEVEE_OMNIHUMAN') == '1'
