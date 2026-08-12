"""
Django settings for the Lumina Studio backend.

Strangler-fig migration off the Next.js API: this app is deployed as a
*separate* service (Railway) from the Next.js frontend (Vercel), so every
setting that matters for a split-origin deployment — CORS, cookie flags,
allowed hosts — is env-driven rather than assumed. See CLAUDE.md for the
domain this backend is progressively taking over.
"""

from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DJANGO_DEBUG=(bool, False),
)
# The Next.js app reads its secrets from a root .env.local; this backend is a
# separate deployable, so it gets its own .env (see backend/.env.example).
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env(
    "DJANGO_SECRET_KEY",
    default="django-insecure-dev-only-do-not-use-in-production",
)

DEBUG = env.bool("DJANGO_DEBUG", default=False)

ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

# URLs mirror the Next.js app's /api/... routes exactly (no trailing slash),
# so the frontend's existing fetch("/api/users") etc. calls don't need to
# change just because the origin does.
APPEND_SLASH = False

# Railway terminates TLS in front of the app and forwards over HTTP; without
# this, Django's own is_secure() check (used by SESSION_COOKIE_SECURE etc.)
# never sees the request as secure.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "apps.common",
    "apps.media",
    "apps.assets",
    "apps.generation",
    "apps.projects",
    "apps.canvas",
    "apps.agents",
    "apps.admin_dashboard",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "apps.common.middleware.SessionRenewalMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# --- Database ---------------------------------------------------------
# Same Postgres instance the Next.js/Drizzle app uses during the strangler
# migration (task #1). Django takes over `manage.py migrate` as the schema's
# source of truth going forward, per the DB-ownership decision — inspectdb
# is a one-time bootstrap, not an ongoing sync.
DATABASES = {
    "default": env.db("DATABASE_URL"),
}
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- Cross-origin session cookie (shared with the Next.js app) --------
# The frontend (Vercel) and this backend (Railway) are different origins, so
# every fetch that must carry the session cookie needs credentials:"include"
# on the client and a cookie that isn't scoped SameSite=Lax (Lax cookies
# aren't sent on cross-site XHR/fetch even for top-level-safe requests).
# AUTH_SECRET/LUMINA_SESSION_COOKIE mirror src/lib/auth.js exactly — see
# apps/common/session_auth.py — because both apps must agree on the cookie
# name and HMAC secret for a cookie minted by one to verify on the other.
AUTH_SECRET = env("AUTH_SECRET", default="dev-insecure-secret-change-me")
LUMINA_SESSION_COOKIE = env("LUMINA_SESSION_COOKIE", default="veevee_session")

CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])
CORS_ALLOW_CREDENTIALS = True

CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.common.session_auth.LuminaSessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    "UNAUTHENTICATED_USER": None,
}
