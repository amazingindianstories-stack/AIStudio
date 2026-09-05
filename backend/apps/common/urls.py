from django.urls import path

from . import auth_views, cron_views, settings_views, views

urlpatterns = [
    path("health", views.health, name="health"),
    path("whoami", views.whoami, name="whoami"),
    path("users", views.list_users, name="users"),
    path("settings", settings_views.settings_view, name="settings"),
    path("auth/login", auth_views.login, name="auth-login"),
    path("auth/logout", auth_views.logout, name="auth-logout"),
    path("auth/me", auth_views.me, name="auth-me"),
    path("auth/password", auth_views.password, name="auth-password"),
    path("cron/login-attempts", cron_views.cleanup_login_attempts, name="cron-login-attempts"),
    path("cron/video-reconciliation", cron_views.reconcile_videos, name="cron-video-reconciliation"),
]
