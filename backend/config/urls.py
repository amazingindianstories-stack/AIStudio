from django.urls import path
from apps.common.views import health

from apps.admin_dashboard.views import effective_settings

from apps.library.views import folder_reads

from apps.assets.views import asset_reads

from apps.authentication.views import current_user

urlpatterns = [path('api/health', health), path('api/settings', effective_settings), path('api/folders', folder_reads), path('api/assets', asset_reads), path('api/auth/me', current_user)]
