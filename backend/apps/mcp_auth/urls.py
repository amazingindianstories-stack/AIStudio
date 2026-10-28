from django.urls import path
from . import views

urlpatterns = [
    path('api/oauth/authorization-server', views.authorization_server_metadata),
    path('api/oauth/protected-resource', views.protected_resource_metadata),
    path('api/oauth/register', views.register),
    path('api/oauth/token', views.token),
    path('api/oauth/revoke', views.revoke),
    path('api/oauth/authorize/request', views.authorize_request),
    path('api/oauth/authorize/decision', views.authorize_decision),
    path('api/mcp/tokens', views.personal_tokens),
    path('api/mcp/tokens/<uuid:identifier>', views.personal_token),
    path('api/mcp/connections/<uuid:identifier>', views.connection),
    path('api/mcp/me', views.bearer_me),
    path('api/admin/agent-access', views.admin_access),
    path('api/admin/agent-access/revoke', views.admin_revoke_all),
]
