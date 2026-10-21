import os
from django.core.wsgi import get_wsgi_application
from apps.common.wsgi import terminated_body_application, slow_request_application, slow_request_slots
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
application = slow_request_application(terminated_body_application(get_wsgi_application()),
    slots=slow_request_slots(os.environ.get('VEEVEE_API_THREADS', '8'), os.environ.get('VEEVEE_SLOW_REQUEST_SLOTS')))

from django.conf import settings  # noqa: E402  (settings are ready after get_wsgi_application)
if getattr(settings, 'VEEVEE_PAID_GUARD', None):
    # A rejected paid reservation becomes a 409 instead of a partial response.
    from apps.generation.services.paid_guard import wrap_wsgi
    application = wrap_wsgi(application)
