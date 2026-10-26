from django.urls import path
from . import enqueue_views as views
from .cancel_views import cancel

urlpatterns = [
    path('api/generate/cancel', cancel),
    path('api/generate/image',views.generate,{'kind':'image'}),
    path('api/generate/video',views.generate,{'kind':'video'}),
    path('api/generate/video/finalize',views.finalize),
    path('api/generate/video/status',views.video_status),
    path('api/generate/upscale',views.upscale),
    path('api/generate/upscale/status',views.upscale_status),
]
