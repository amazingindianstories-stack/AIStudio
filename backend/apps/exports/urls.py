from django.urls import path
from . import views

urlpatterns = [
    path('api/history/exports', views.create),
    path('api/history/exports/<str:id>', views.status),
    path('api/history/exports/<str:id>/items', views.items),
    path('api/history/exports/<str:id>/finalize', views.finalize),
    path('api/history/exports/<str:id>/download', views.download),
    path('api/worker/exports/access', views.worker_access),
]
