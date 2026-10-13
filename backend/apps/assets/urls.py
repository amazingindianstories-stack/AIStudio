from django.urls import path
from .portraits import portraits, group_assets, upload

urlpatterns = [
    path('api/assets/portraits', portraits),
    path('api/assets/portraits/upload', upload),
    path('api/assets/portraits/<str:id>/assets', group_assets),
]
