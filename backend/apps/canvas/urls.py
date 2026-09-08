from django.urls import path

from . import canvas_views

urlpatterns = [
    path("canvas-boards", canvas_views.canvas_boards, name="canvas-boards"),
    path("canvas-boards/<str:board_id>", canvas_views.canvas_board_detail, name="canvas-board-detail"),
    path("canvas-boards/<str:board_id>/upload", canvas_views.canvas_board_upload, name="canvas-board-upload"),
]
