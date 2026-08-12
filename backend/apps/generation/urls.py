from django.urls import path

from . import generation_views, history_views

urlpatterns = [
    path("history", history_views.history, name="history"),
    path("history/counts", history_views.history_counts, name="history-counts"),
    path("history/updates", history_views.history_updates, name="history-updates"),
    path("history/download-zip", history_views.history_download_zip, name="history-download-zip"),
    path("generate/image", generation_views.generate_image, name="generate-image"),
    path("generate/video", generation_views.generate_video, name="generate-video"),
    path("generate/video/status", generation_views.video_status, name="generate-video-status"),
    path("queue/execute", generation_views.queue_execute, name="queue-execute"),
    path("queue/status", generation_views.queue_status, name="queue-status"),
]
