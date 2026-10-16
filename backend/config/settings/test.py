import os
from django.core.exceptions import ImproperlyConfigured
from .base import *  # noqa: F403

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or DATABASES['default']['HOST'] not in ('127.0.0.1', 'localhost') or DATABASES['default']['NAME'] != 'veevee_django_migration':
    raise ImproperlyConfigured('Qualification requires the disposable local migration database')
ALLOWED_HOSTS = ['localhost', '127.0.0.1', 'testserver']

SESSION_COOKIE_SECURE = False
