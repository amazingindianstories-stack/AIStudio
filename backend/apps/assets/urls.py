from django.urls import path
from .portraits import portraits, group_assets, upload
from .managed_views import (portrait_settings, portraits_collection, portraits_delete, portraits_rename,
                            retired_in_managed_mode)

urlpatterns = [
    path('api/assets/portraits', retired_in_managed_mode(portraits)),
    path('api/assets/portraits/upload', retired_in_managed_mode(upload)),
    path('api/assets/portraits/<str:id>/assets', retired_in_managed_mode(group_assets)),
    path('api/portraits', portraits_collection),
    path('api/portraits/delete', portraits_delete),
    path('api/portraits/<uuid:id>', portraits_rename),
    path('api/admin/portrait-settings', portrait_settings),
]
