from django.urls import path

from . import depth_views, generation_views, history_views

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
    path("generate/depth", depth_views.generate_depth, name="generate-depth"),
    path("generate/depth/status", depth_views.depth_status, name="generate-depth-status"),
    path("worker/depth/status", depth_views.worker_status, name="worker-depth-status"),
    path("worker/depth/heartbeat", depth_views.worker_heartbeat, name="worker-depth-heartbeat"),
    path("worker/depth/claim", depth_views.worker_claim, name="worker-depth-claim"),
    path("worker/depth/progress", depth_views.worker_progress, name="worker-depth-progress"),
    path("worker/depth/upload-url", depth_views.worker_upload_url, name="worker-depth-upload-url"),
    path("worker/depth/complete", depth_views.worker_complete, name="worker-depth-complete"),
]
