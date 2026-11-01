"""Include at the root; string paths preserve source invalid-UUID responses."""
from django.urls import path
from .facilitation_views import (board_facilitation, board_private_mode, board_timer, board_voting, board_voting_done,
                                 board_voting_session, board_voting_vote)
from .views import (board_access, board_activity, board_ai_job, board_ai_jobs, board_ai_quote, board_detail, board_metadata_reads,
                    board_upload, board_version, board_changes, shape_packs, shape_pack_detail)

urlpatterns = [
    path('api/canvas-boards', board_metadata_reads),
    path('api/canvas-boards/<str:identifier>/upload', board_upload),
    path('api/canvas-boards/<str:identifier>/access', board_access),
    path('api/canvas-boards/<str:identifier>/version', board_version),
    path('api/canvas-boards/<str:identifier>/changes', board_changes),
    path('api/canvas-boards/<str:identifier>/activity', board_activity),
    path('api/canvas-boards/<str:identifier>/ai-jobs', board_ai_jobs),
    path('api/canvas-boards/<str:identifier>/ai-jobs/quote', board_ai_quote),
    path('api/canvas-boards/<str:identifier>/ai-jobs/<str:job_id>', board_ai_job),
    path('api/canvas-boards/<str:identifier>/facilitation', board_facilitation),
    path('api/canvas-boards/<str:identifier>/timer', board_timer),
    path('api/canvas-boards/<str:identifier>/voting', board_voting),
    path('api/canvas-boards/<str:identifier>/voting/<str:session_id>', board_voting_session),
    path('api/canvas-boards/<str:identifier>/voting/<str:session_id>/vote', board_voting_vote),
    path('api/canvas-boards/<str:identifier>/voting/<str:session_id>/done', board_voting_done),
    path('api/canvas-boards/<str:identifier>/private-mode', board_private_mode),
    path('api/canvas-boards/<str:identifier>', board_detail),
    path('api/canvas-shape-packs', shape_packs),
    path('api/canvas-shape-packs/<str:identifier>', shape_pack_detail),
]
