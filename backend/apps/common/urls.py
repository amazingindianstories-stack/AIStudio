from django.urls import path

from . import auth_views, views

urlpatterns = [
    path("health", views.health, name="health"),
    path("whoami", views.whoami, name="whoami"),
    path("users", views.list_users, name="users"),
    path("auth/login", auth_views.login, name="auth-login"),
    path("auth/logout", auth_views.logout, name="auth-logout"),
    path("auth/me", auth_views.me, name="auth-me"),
    path("auth/password", auth_views.password, name="auth-password"),
]
