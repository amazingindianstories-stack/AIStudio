"""Include at the root; string paths preserve source invalid-UUID responses."""
from django.urls import path
from .synced import board_frame, board_frames, frame_copies
from .template_views import (blueprint_detail, blueprint_list, blueprint_use, template_comments, template_detail,
                             template_edit_board, template_for_board, template_like, template_list, template_use)
from .views import (board_access, board_activity, board_ai_job, board_ai_jobs, board_ai_quote, board_detail, board_metadata_reads,
                    board_upload, board_version, board_changes, shape_packs, shape_pack_detail)

from .media_views import media_detail, media_library, import_url
from .work_views import tables, table_detail, table_history, notification_inbox

from . import views_collab as collab

urlpatterns = [
    path("api/board-notifications", notification_inbox),
    path("api/canvas-boards/<str:identifier>/work", tables),
    path("api/canvas-boards/<str:identifier>/work/<str:table_id>", table_detail),
    path("api/canvas-boards/<str:identifier>/work/<str:table_id>/history", table_history),
    path("api/canvas-boards/<str:identifier>/media", media_library),
    path("api/canvas-boards/<str:identifier>/media/<str:media_id>", media_detail),
    path("api/canvas-boards/<str:identifier>/import-url", import_url),
    path('api/canvas-boards/<str:identifier>/comments', collab.board_comments),
    path('api/canvas-boards/<str:identifier>/comments/read', collab.board_comments_read),
    path('api/canvas-boards/<str:identifier>/comments/follow', collab.board_comments_follow),
    path('api/canvas-boards/<str:identifier>/comments/mentions', collab.board_mention_suggestions),
    path('api/canvas-boards/<str:identifier>/comments/<str:comment_id>', collab.board_comment),
    path('api/canvas-boards/<str:identifier>/comments/<str:comment_id>/resolve', collab.board_comment_resolve),
    path('api/canvas-boards/<str:identifier>/comments/<str:comment_id>/react', collab.board_comment_react),
    path('api/canvas-boards/<str:identifier>/pulse', collab.board_pulse),
    path('api/notifications', collab.notification_feed),
    path('api/notifications/read', collab.notification_read),
    path('api/push-subscription', collab.push_subscription),
    path('api/canvas-boards', board_metadata_reads),
    path('api/canvas-boards/<str:identifier>/upload', board_upload),
    path('api/canvas-boards/<str:identifier>/access', board_access),
    path('api/canvas-boards/<str:identifier>/version', board_version),
    path('api/canvas-boards/<str:identifier>/changes', board_changes),
    path('api/canvas-boards/<str:identifier>/frames', board_frames),
    path('api/canvas-boards/<str:identifier>/frames/<str:node_id>', board_frame),
    path('api/canvas-boards/<str:identifier>/frames/<str:node_id>/copies', frame_copies),
    path('api/canvas-boards/<str:identifier>/activity', board_activity),
    path('api/canvas-boards/<str:identifier>/ai-jobs', board_ai_jobs),
    path('api/canvas-boards/<str:identifier>/ai-jobs/quote', board_ai_quote),
    path('api/canvas-boards/<str:identifier>/ai-jobs/<str:job_id>', board_ai_job),
    path('api/canvas-boards/<str:identifier>', board_detail),
    path('api/canvas-templates', template_list),
    path('api/canvas-templates/by-board/<str:board_id>', template_for_board),
    path('api/canvas-templates/<str:ref>/edit-board', template_edit_board),
    path('api/canvas-templates/<str:ref>/use', template_use),
    path('api/canvas-templates/<str:ref>/like', template_like),
    path('api/canvas-templates/<str:ref>/comments', template_comments),
    path('api/canvas-templates/<str:ref>', template_detail),
    path('api/canvas-blueprints', blueprint_list),
    path('api/canvas-blueprints/<str:ref>/use', blueprint_use),
    path('api/canvas-blueprints/<str:ref>', blueprint_detail),
    path('api/canvas-shape-packs', shape_packs),
    path('api/canvas-shape-packs/<str:identifier>', shape_pack_detail),
]
