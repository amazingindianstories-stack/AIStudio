from django.urls import path
from .views import project_reads

urlpatterns = [path('api/projects', project_reads)]
