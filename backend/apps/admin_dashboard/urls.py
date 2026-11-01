from django.urls import path
from .admin_api import user_mutations, pricing_mutation, global_limit_mutation, user_limit_mutation, token_mutation, retired_schema_migration
from .queries import dashboard, logs, activity
from .errors import errors
from .status import status_view
from .runtime_audit import runtime_audit
from .content_log import content_log
from .workspace import workspace_view, workspace_admin

urlpatterns = [
    path('api/admin/users',user_mutations),
    path('api/admin/pricing',pricing_mutation),
    path('api/admin/limits',global_limit_mutation),
    path('api/admin/user-limits',user_limit_mutation),
    path('api/admin/workspace',workspace_admin),
    path('api/workspace',workspace_view),
    path('api/admin/data',dashboard),
    path('api/admin/logs',logs),
    path('api/admin/errors',errors),
    path('api/admin/activity',activity),
    path('api/admin/content-log',content_log),
    path('api/admin/status',status_view),
    path('api/admin/audit/runtime',runtime_audit),
    path('api/admin/set-token',token_mutation),
    path('api/admin/migrate-schema',retired_schema_migration),
]
