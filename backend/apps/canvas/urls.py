"""Include at the root; string paths preserve source invalid-UUID responses."""
from django.urls import path
from .views import board_detail, board_metadata_reads, board_upload

urlpatterns = [
    path('api/canvas-boards', board_metadata_reads),
    path('api/canvas-boards/<str:identifier>/upload', board_upload),
    path('api/canvas-boards/<str:identifier>', board_detail),
]
