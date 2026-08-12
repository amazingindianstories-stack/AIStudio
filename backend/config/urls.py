from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("django-admin/", admin.site.urls),
    # Mirrors the Next.js app's /api/... prefix so ported routes keep the
    # same path the frontend already calls — only the origin changes.
    path("api/", include("apps.common.urls")),
    path("api/", include("apps.media.urls")),
    path("api/", include("apps.assets.urls")),
    path("api/", include("apps.generation.urls")),
    path("api/", include("apps.projects.urls")),
    path("api/", include("apps.canvas.urls")),
    path("api/", include("apps.agents.urls")),
    path("api/", include("apps.admin_dashboard.urls")),
]
