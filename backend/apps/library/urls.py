from django.urls import path
from .views import folder_reads

urlpatterns = [path('api/folders', folder_reads)]
