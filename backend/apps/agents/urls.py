from django.urls import path
from . import views

urlpatterns = [
    path('api/agent-conversations', views.conversations),
    path('api/agent-conversations/<str:id>', views.detail),
    path('api/agent-conversations/<str:id>/transcribe', views.transcribe),
    path('api/agent-conversations/<str:id>/messages/<str:message_id>', views.attach),
    path('api/agent-conversations/<str:id>/runs', views.agent_runs),
    path('api/agent-conversations/<str:id>/runs/<str:run_id>/events', views.run_events),
    path('api/agent-conversations/<str:id>/runs/<str:run_id>/approve', views.run_quote, {'decision': 'approve'}),
    path('api/agent-conversations/<str:id>/runs/<str:run_id>/decline', views.run_quote, {'decision': 'decline'}),
    path('api/agent-conversations/<str:id>/runs/<str:run_id>/cancel', views.run_cancel),
]
