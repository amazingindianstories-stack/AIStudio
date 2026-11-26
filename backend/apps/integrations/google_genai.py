"""Where Veevee's Gemini calls go: the Gemini API (the default) or Vertex AI, chosen by environment at call time.

    GOOGLE_GENAI_BACKEND unset or 'gemini': generativelanguage.googleapis.com with GOOGLE_API_KEY, exactly as before.
    GOOGLE_GENAI_BACKEND=vertex: aiplatform.googleapis.com with an OAuth access token from Application Default
      Credentials (google.auth.default, cloud-platform scope; on Railway the service account key the deploy entrypoint
      writes from GCP_ADC_JSON to GOOGLE_APPLICATION_CREDENTIALS). Tokens are cached and refreshed here.
      GOOGLE_VERTEX_IMPERSONATE_SA  optional: a service account to impersonate with those credentials (they need the
                                    Service Account Token Creator role on it); it, not the ADC identity, then needs
                                    the Vertex AI User role.
      GCP_PROJECT_ID, else GOOGLE_CLOUD_PROJECT  the project calls are scoped and billed to.
      GOOGLE_VERTEX_LOCATION        optional region (default global) of every call except to the models Vertex serves
                                    only from global (GLOBAL_ONLY).

Vertex AI REST (docs.cloud.google.com/vertex-ai/generative-ai/docs, read 2026-11-26): generateContent is
POST https://{host}/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent with a
bearer token, where the host is aiplatform.googleapis.com for global and {location}-aiplatform.googleapis.com for a
region. Request and response bodies are the Gemini API's (contents, systemInstruction, tools, generationConfig;
candidates, usageMetadata). Vertex has no Files API (apps.agents.media refuses the files that would need one) and no
`-latest` model aliases, hence the pinned Vertex defaults below. Credentials and tokens never appear in an error, log
or URL.
"""
import logging
import os
import re
import threading
from urllib.parse import quote

from .errors import ProviderError
from .transport import required_key

logger = logging.getLogger(__name__)

SWITCH = 'GOOGLE_GENAI_BACKEND'
BACKENDS = ('gemini', 'vertex')
GEMINI_HOST = 'generativelanguage.googleapis.com'
VERTEX_HOST = 'aiplatform.googleapis.com'
GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
IMPERSONATE = 'GOOGLE_VERTEX_IMPERSONATE_SA'
LOCATION = 'GOOGLE_VERTEX_LOCATION'
PROJECTS = ('GCP_PROJECT_ID', 'GOOGLE_CLOUD_PROJECT')
VERTEX_MISSING = 'Vertex AI has no project: set GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT.'
SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
# A Google Cloud project id: 6 to 30 lowercase letters, digits and hyphens, starting with a letter.
PROJECT_ID = re.compile(r'[a-z][a-z0-9-]{4,28}[a-z0-9]')
# A Google Cloud region such as us-central1 or europe-west4 ('global' is the default location).
REGION = re.compile(r'[a-z]+(?:-[a-z]+)+[0-9]+')
SERVICE_ACCOUNT = re.compile(r'[a-z0-9][a-z0-9-]{4,62}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.gserviceaccount\.com')
# Models Vertex serves only from the global location (docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/
# 3-pro-image and .../nano-banana-2-1, read 2026-11-26): their calls ignore GOOGLE_VERTEX_LOCATION.
GLOBAL_ONLY = frozenset({'gemini-3-pro-image', 'gemini-nano-banana-2.1'})
# Pinned Vertex models standing in for defaults Vertex does not serve: the Gemini API's `gemini-flash-latest` and
# `gemini-pro-latest` aliases, and gemini-2.5-flash (retired on Vertex 2026-10-20). Both are on Vertex's model list
# (gemini-3.8-flash GA, gemini-3.1-pro-preview preview; read 2026-11-26), and they are the Agents tab's own models.
VERTEX_FLASH = 'gemini-3.8-flash'
VERTEX_PRO = 'gemini-3.1-pro-preview'


def _env(env):
    return os.environ if env is None else env


def _value(env, name):
    value = env.get(name)
    return value if value and value != '[SENSITIVE]' else None


def _refuse(message):
    return ProviderError(message, code='missing_configuration', may_have_submitted=False)


def is_vertex(env=None):
    """True when GOOGLE_GENAI_BACKEND is 'vertex'; any value but 'gemini', 'vertex' or unset is refused."""
    backend = _env(env).get(SWITCH) or 'gemini'
    if backend not in BACKENDS:
        raise _refuse(f'{SWITCH} must be gemini or vertex.')
    return backend == 'vertex'


def credential_name(env=None):
    """The variable an admin sets to configure the active backend, for refusals."""
    return ' or '.join(PROJECTS) if is_vertex(env) else 'GOOGLE_API_KEY'


def configured(env=None):
    """Whether the active backend is configured: GOOGLE_API_KEY on the Gemini API, a project on Vertex AI (presence
    only; Application Default Credentials are loaded at the first call)."""
    env = _env(env)
    if is_vertex(env):
        return any(_value(env, name) for name in PROJECTS)
    return bool(_value(env, 'GOOGLE_API_KEY'))


def vertex_default(env, gemini_model, vertex_model=VERTEX_FLASH):
    """``gemini_model`` on the Gemini API, ``vertex_model`` on Vertex AI."""
    return vertex_model if is_vertex(env) else gemini_model


def project(env=None):
    """The Vertex project: GCP_PROJECT_ID, else GOOGLE_CLOUD_PROJECT."""
    env = _env(env)
    value = next((_value(env, name) for name in PROJECTS if _value(env, name)), None)
    if value is None:
        raise _refuse(VERTEX_MISSING)
    if not PROJECT_ID.fullmatch(value):
        raise _refuse('The Vertex AI project is not a Google Cloud project id.')
    return value


def location(model=None, env=None):
    """The Vertex location of a call to ``model``: global for ``GLOBAL_ONLY`` models, else GOOGLE_VERTEX_LOCATION
    (default global)."""
    value = _value(_env(env), LOCATION) or 'global'
    if value != 'global' and not REGION.fullmatch(value):
        raise _refuse(f'{LOCATION} is not a Google Cloud region.')
    return 'global' if model in GLOBAL_ONLY else value


def impersonated(env=None):
    """The service account GOOGLE_VERTEX_IMPERSONATE_SA names, or None to call as the ADC identity itself."""
    value = _value(_env(env), IMPERSONATE)
    if value is not None and not SERVICE_ACCOUNT.fullmatch(value):
        raise _refuse(f'{IMPERSONATE} is not a service account email.')
    return value


def check(env=None):
    """Refuse an unusable Vertex project, location or impersonation target, without loading credentials."""
    project(env)
    location(env=env)
    impersonated(env)


def host(env=None, model=None):
    """The host a call to ``model`` (else to any model outside ``GLOBAL_ONLY``) goes to on the active backend."""
    if not is_vertex(env):
        return GEMINI_HOST
    place = location(model, env)
    return VERTEX_HOST if place == 'global' else f'{place}-{VERTEX_HOST}'


def hosts(env=None):
    """Every host the active backend calls, for a transport that serves any model."""
    return sorted({host(env), host(env, next(iter(GLOBAL_ONLY)))})


def model_url(model, method='generateContent', env=None):
    """The ``method`` URL of Google model ``model`` on the active backend."""
    name = quote(model, safe='')
    if not is_vertex(env):
        return f'{GEMINI_ROOT}/models/{name}:{method}'
    return (f'https://{host(env, model)}/v1/projects/{project(env)}/locations/{location(model, env)}'
            f'/publishers/google/models/{name}:{method}')


_lock = threading.Lock()
_credentials = {}    # impersonated service account ('' for the ADC identity) -> google-auth credentials, refreshed in place


def _load(target):
    import google.auth
    credentials, _ = google.auth.default(scopes=[SCOPE])
    if target:
        from google.auth import impersonated_credentials
        credentials = impersonated_credentials.Credentials(source_credentials=credentials, target_principal=target,
                                                           target_scopes=[SCOPE], lifetime=3600)
    return credentials


def _access_token(target):
    """A current OAuth access token for Application Default Credentials, as ``target`` when given: one credentials
    object per target, refreshed under a lock shortly before it expires. A failure logs and says only its kind."""
    with _lock:
        credentials = _credentials.get(target or '')
        if credentials is None:
            try:
                credentials = _load(target)
            except Exception as error:
                logger.warning('vertex_credentials_unavailable error_type=%s', type(error).__name__)
                raise ProviderError('Vertex AI could not load Application Default Credentials.', code='vertex_auth',
                                    may_have_submitted=False) from None
            _credentials.clear()
            _credentials[target or ''] = credentials
        if not credentials.valid:
            import requests
            from google.auth.transport.requests import Request
            try:
                with requests.Session() as session:
                    session.trust_env = False
                    credentials.refresh(Request(session))
            except Exception as error:
                logger.warning('vertex_token_refresh_failed error_type=%s', type(error).__name__)
                raise ProviderError('Vertex AI access token could not be minted.', code='vertex_auth',
                                    may_have_submitted=False) from None
        return credentials.token


def auth_headers(env=None, missing=None):
    """The credential header of one request on the active backend. ``missing`` replaces the Gemini API's default refusal
    when GOOGLE_API_KEY is unset. Vertex first refuses an unusable project, location or impersonation target, then
    mints (or reuses) a token."""
    env = _env(env)
    if not is_vertex(env):
        return {'x-goog-api-key': required_key(env, 'GOOGLE_API_KEY', missing)}
    check(env)
    return {'Authorization': 'Bearer ' + _access_token(impersonated(env))}
