from django.urls import path
from apps.common.views import health

from apps.admin_dashboard.views import effective_settings

urlpatterns = [path('api/health', health), path('api/settings', effective_settings)]
