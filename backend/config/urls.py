from django.urls import path
from apps.common.views import health

from apps.admin_dashboard.views import effective_settings

from apps.library.views import folder_reads

from apps.assets.views import asset_reads

from apps.authentication.views import current_user, login, logout, change_password

from apps.projects.views import project_reads

from apps.canvas.views import board_metadata_reads

from apps.generation.history_counts import history_counts

from apps.generation.updates import generation_updates

urlpatterns = [path('api/history/updates', generation_updates), path('api/history/counts', history_counts), path('api/canvas-boards', board_metadata_reads), path('api/health', health), path('api/settings', effective_settings), path('api/folders', folder_reads), path('api/assets', asset_reads), path('api/auth/me', current_user), path('api/auth/login', login), path('api/auth/logout', logout), path('api/auth/password', change_password), path('api/projects', project_reads)]
