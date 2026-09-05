from django.urls import path

from . import media_views, upload_views

urlpatterns = [
    path("media-grant", media_views.media_grant_view, name="media-grant"),
    path("uploads/presign", upload_views.presign_upload, name="uploads-presign"),
    path("media/<path:path>", media_views.serve_media, name="media"),
]
