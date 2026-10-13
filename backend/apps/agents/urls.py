from django.urls import path
from . import views

urlpatterns = [
    path('api/agent-conversations', views.conversations),
    path('api/agent-conversations/<str:id>', views.detail),
    path('api/agent-conversations/<str:id>/messages', views.messages),
    path('api/agent-conversations/<str:id>/messages/<str:message_id>', views.attach),
]
