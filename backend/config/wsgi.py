import os
from django.core.wsgi import get_wsgi_application
from apps.common.wsgi import terminated_body_application, slow_request_application
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
application = slow_request_application(terminated_body_application(get_wsgi_application()))

from django.conf import settings  # noqa: E402  (settings are ready after get_wsgi_application)
if getattr(settings, 'VEEVEE_PAID_GUARD', None):
    # A rejected paid reservation becomes a 409 instead of a partial response.
    from apps.production_runtime.paid_guard import wrap_wsgi
    application = wrap_wsgi(application)
