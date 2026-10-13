from django.urls import include, path
from apps.common.views import health

from apps.admin_dashboard.views import effective_settings

from apps.library.views import folder_reads

from apps.assets.views import asset_reads

from apps.authentication.views import current_user, login, logout, change_password, list_users

from apps.projects.views import project_reads

from apps.canvas.views import board_metadata_reads

from apps.generation.history_counts import history_counts

from apps.generation.updates import generation_updates

from apps.generation.history import history_reads

from apps.generation.queue_views import queue_status
from apps.media import views as media_views
from apps.media.audio import transcribe
from apps.generation.callbacks import seedance_callback, retired_queue_execute

urlpatterns = [
    path('api/health', health),
    path('api/auth/me', current_user),
    path('api/auth/login', login),
    path('api/auth/logout', logout),
    path('api/auth/password', change_password),
    path('api/users', list_users),
    path('api/settings', effective_settings),
    path('api/assets', asset_reads),
    path('', include('apps.generation.history_urls')),
    path('api/history/updates', generation_updates),
    path('api/history/counts', history_counts),
    path('api/queue/status', queue_status),
    path('api/queue/execute', retired_queue_execute),
    path('api/webhooks/seedance', seedance_callback),
    path('api/media-grant', media_views.media_grant),
    path('api/media-resolve', media_views.media_resolve),
    path('api/media/<path:path>', media_views.media),
    path('api/uploads/init', media_views.upload_init),
    path('api/uploads/<uuid:id>/status', media_views.upload_session_status),
    path('api/uploads/<uuid:id>/finalize', media_views.upload_finalize),
    path('api/uploads/<uuid:id>/cancel', media_views.upload_cancel),
    path('api/uploads/<uuid:id>/local', media_views.local_resumable_upload),
    path('api/uploads/presign', media_views.upload_presign),
    path('api/uploads/local', media_views.local_upload),
    path('api/generations/<str:id>/download', media_views.generation_download),
    path('api/audio/transcribe', transcribe),
    path('', include('apps.canvas.urls')),
    path('', include('apps.library.urls')),
    path('', include('apps.projects.urls')),
    path('', include('apps.exports.urls')),
    path('', include('apps.admin_dashboard.urls')),
    path('', include('apps.assets.urls')),
    path('', include('apps.agents.urls')),
    path('', include('apps.workers.urls')),
    path('', include('apps.generation.enqueue_urls')),
]
