from django.urls import path
from .views import project_members, project_reads

urlpatterns = [path('api/projects', project_reads),
    path('api/projects/<str:project_id>/members', project_members)]
