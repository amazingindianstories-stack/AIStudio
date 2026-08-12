from django.urls import path

from . import media_views

urlpatterns = [
    path("media-grant", media_views.media_grant_view, name="media-grant"),
    path("media/<path:path>", media_views.serve_media, name="media"),
]
