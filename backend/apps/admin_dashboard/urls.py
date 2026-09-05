from django.urls import path

from . import admin_views

urlpatterns = [
    path("admin/data", admin_views.admin_data, name="admin-data"),
    path("admin/users", admin_views.admin_users, name="admin-users"),
    path("admin/pricing", admin_views.admin_pricing, name="admin-pricing"),
    path("admin/set-token", admin_views.admin_set_token, name="admin-set-token"),
    path("admin/logs", admin_views.admin_logs_view, name="admin-logs"),
    path("admin/activity", admin_views.admin_activity_view, name="admin-activity"),
    path("admin/status", admin_views.admin_status_view, name="admin-status"),
    path("admin/limits", admin_views.admin_limits, name="admin-limits"),
    path("admin/user-limits", admin_views.admin_user_limits, name="admin-user-limits"),
    path("admin/audit/runtime", admin_views.admin_runtime_audit, name="admin-runtime-audit"),
]
