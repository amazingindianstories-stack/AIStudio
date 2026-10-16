from django.urls import path
from .portraits import portraits, group_assets, upload
from .managed_views import managed_delete, managed_list, manual_upload_guard, portrait_settings

urlpatterns = [
    path('api/assets/portraits', portraits),
    path('api/assets/portraits/upload', manual_upload_guard(upload)),
    path('api/assets/portraits/<str:id>/assets', manual_upload_guard(group_assets)),
    path('api/portraits/managed', managed_list),
    path('api/portraits/managed/<uuid:id>', managed_delete),
    path('api/admin/portrait-settings', portrait_settings),
]
