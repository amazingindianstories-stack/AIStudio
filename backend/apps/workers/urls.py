from django.urls import path
from . import views

urlpatterns = [
    path(f'api/worker/depth/{operation}', views.worker, {'operation': operation})
    for operation in ('claim', 'heartbeat', 'progress', 'upload-url', 'complete')
] + [
    path('api/worker/depth/status', views.worker_status),
    path('api/generate/depth', views.enqueue),
    path('api/generate/depth/status', views.generation_status),
]
