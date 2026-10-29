"""Include at the root; string paths preserve source invalid-UUID responses."""
from django.urls import path
from .views import (board_access, board_ai_job, board_ai_jobs, board_ai_quote, board_detail, board_metadata_reads, board_upload,
                    board_version)

urlpatterns = [
    path('api/canvas-boards', board_metadata_reads),
    path('api/canvas-boards/<str:identifier>/upload', board_upload),
    path('api/canvas-boards/<str:identifier>/access', board_access),
    path('api/canvas-boards/<str:identifier>/version', board_version),
    path('api/canvas-boards/<str:identifier>/ai-jobs', board_ai_jobs),
    path('api/canvas-boards/<str:identifier>/ai-jobs/quote', board_ai_quote),
    path('api/canvas-boards/<str:identifier>/ai-jobs/<str:job_id>', board_ai_job),
    path('api/canvas-boards/<str:identifier>', board_detail),
]
