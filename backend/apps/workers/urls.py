from django.urls import path
from . import views
from .cron import cron

urlpatterns = [
    path(f'api/worker/depth/{operation}', views.worker, {'operation': operation})
    for operation in ('claim', 'heartbeat', 'progress', 'upload-url', 'complete')
] + [
    path('api/worker/depth/status', views.worker_status),
    path('api/generate/depth', views.enqueue),
    path('api/generate/depth/status', views.generation_status),
] + [
    path(f'api/cron/{operation}', cron, {'operation': operation})
    for operation in ('login-attempts', 'depth-reconciliation', 'video-reconciliation')
]
