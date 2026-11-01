"""Include at the root; string paths preserve source invalid-UUID responses."""
from django.urls import path
from . import api_v1
from .views import (board_access, board_activity, board_ai_job, board_ai_jobs, board_ai_quote, board_detail, board_metadata_reads,
                    board_upload, board_version, board_changes, shape_packs, shape_pack_detail)

urlpatterns = [
    path('api/v1/boards', api_v1.boards),
    path('api/v1/boards/<str:identifier>', api_v1.board),
    path('api/v1/boards/<str:identifier>/items', api_v1.items_collection),
    path('api/v1/boards/<str:identifier>/items/<str:item_id>', api_v1.items_member),
    path('api/v1/boards/<str:identifier>/connectors', api_v1.connectors_collection),
    path('api/v1/boards/<str:identifier>/connectors/<str:item_id>', api_v1.connectors_member),
    path('api/v1/boards/<str:identifier>/changes', api_v1.board_change_feed),
    path('api/canvas-boards', board_metadata_reads),
    path('api/canvas-boards/<str:identifier>/upload', board_upload),
    path('api/canvas-boards/<str:identifier>/access', board_access),
    path('api/canvas-boards/<str:identifier>/version', board_version),
    path('api/canvas-boards/<str:identifier>/changes', board_changes),
    path('api/canvas-boards/<str:identifier>/activity', board_activity),
    path('api/canvas-boards/<str:identifier>/ai-jobs', board_ai_jobs),
    path('api/canvas-boards/<str:identifier>/ai-jobs/quote', board_ai_quote),
    path('api/canvas-boards/<str:identifier>/ai-jobs/<str:job_id>', board_ai_job),
    path('api/canvas-boards/<str:identifier>', board_detail),
    path('api/canvas-shape-packs', shape_packs),
    path('api/canvas-shape-packs/<str:identifier>', shape_pack_detail),
]
