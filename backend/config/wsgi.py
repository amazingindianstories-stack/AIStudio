import os
from django.core.wsgi import get_wsgi_application
from apps.common.wsgi import terminated_body_application, slow_request_application
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
application = slow_request_application(terminated_body_application(get_wsgi_application()))
