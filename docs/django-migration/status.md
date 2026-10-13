# Local Django implementation status

Generated from local-implementation.json and source; historical production ownership is separate.

| Measure | Local undeployed source |
|---|---|
| Implemented methods | 83 / 85 |
| Intentional authenticated 410 retirements | 2 |
| Added local upload methods | 5; not deployed |
| Managed physical models | 22 |
| Schema authority | DJANGO_MANAGED |
| Node source retirement | COMPLETE |
| Historical manifest Django traffic owners | 0 / 85; live routing not inspected |
| Production adoption/deployment | Pending separate authorization |

## Method coverage

| Method | Route | Local state | Test source |
|---|---|---|---|
| GET | /api/admin/activity | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/audit/runtime | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| GET | /api/admin/data | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/limits | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| GET | /api/admin/logs | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/migrate-schema | INTENTIONALLY_RETIRED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/pricing | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/set-token | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| GET | /api/admin/status | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/user-limits | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/admin/users | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| PATCH | /api/admin/users | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| DELETE | /api/admin/users | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| PATCH | /api/agent-conversations/[id]/messages/[messageId] | DJANGO_IMPLEMENTED_LOCAL | backend/apps/agents/test_contracts.py |
| POST | /api/agent-conversations/[id]/messages | DJANGO_IMPLEMENTED_LOCAL | backend/apps/agents/test_contracts.py |
| GET | /api/agent-conversations/[id] | DJANGO_IMPLEMENTED_LOCAL | backend/apps/agents/test_contracts.py |
| GET | /api/agent-conversations | DJANGO_IMPLEMENTED_LOCAL | backend/apps/agents/test_contracts.py |
| POST | /api/agent-conversations | DJANGO_IMPLEMENTED_LOCAL | backend/apps/agents/test_contracts.py |
| GET | /api/assets/portraits/[id]/assets | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| POST | /api/assets/portraits/[id]/assets | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| DELETE | /api/assets/portraits/[id]/assets | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| GET | /api/assets/portraits | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| POST | /api/assets/portraits | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| PATCH | /api/assets/portraits | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| DELETE | /api/assets/portraits | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| POST | /api/assets/portraits/upload | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/test_portrait_contracts.py |
| GET | /api/assets | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/tests.py |
| POST | /api/assets | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/tests.py |
| DELETE | /api/assets | DJANGO_IMPLEMENTED_LOCAL | backend/apps/assets/tests.py |
| POST | /api/audio/transcribe | DJANGO_IMPLEMENTED_LOCAL | backend/apps/media/test_media.py |
| POST | /api/auth/login | DJANGO_IMPLEMENTED_LOCAL | backend/apps/authentication/tests.py |
| POST | /api/auth/logout | DJANGO_IMPLEMENTED_LOCAL | backend/apps/authentication/tests.py |
| GET | /api/auth/me | DJANGO_IMPLEMENTED_LOCAL | backend/apps/authentication/tests.py |
| PATCH | /api/auth/me | DJANGO_IMPLEMENTED_LOCAL | backend/apps/authentication/tests.py |
| PATCH | /api/auth/password | DJANGO_IMPLEMENTED_LOCAL | backend/apps/authentication/tests.py |
| GET | /api/canvas-boards/[id] | DJANGO_IMPLEMENTED_LOCAL | backend/apps/canvas/tests.py |
| PUT | /api/canvas-boards/[id] | DJANGO_IMPLEMENTED_LOCAL | backend/apps/canvas/tests.py |
| POST | /api/canvas-boards/[id]/upload | DJANGO_IMPLEMENTED_LOCAL | backend/apps/canvas/tests.py |
| GET | /api/canvas-boards | DJANGO_IMPLEMENTED_LOCAL | backend/apps/canvas/tests.py |
| POST | /api/canvas-boards | DJANGO_IMPLEMENTED_LOCAL | backend/apps/canvas/tests.py |
| GET | /api/cron/depth-reconciliation | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| GET | /api/cron/login-attempts | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| GET | /api/cron/video-reconciliation | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| GET | /api/folders | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| POST | /api/folders | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| PATCH | /api/folders | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| DELETE | /api/folders | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| POST | /api/generate/depth | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| GET | /api/generate/depth/status | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| POST | /api/generate/image | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_enqueue.py |
| POST | /api/generate/upscale | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_enqueue.py |
| GET | /api/generate/upscale/status | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_enqueue.py |
| POST | /api/generate/video/finalize | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_enqueue.py |
| POST | /api/generate/video | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_enqueue.py |
| GET | /api/generate/video/status | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_enqueue.py |
| GET | /api/generations/[id]/download | DJANGO_IMPLEMENTED_LOCAL | backend/apps/media/test_media.py |
| HEAD | /api/generations/[id]/download | DJANGO_IMPLEMENTED_LOCAL | backend/apps/media/test_media.py |
| GET | /api/history/counts | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/tests.py |
| GET | /api/history/exports/[id]/download | DJANGO_IMPLEMENTED_LOCAL | backend/apps/exports/tests.py |
| POST | /api/history/exports/[id]/finalize | DJANGO_IMPLEMENTED_LOCAL | backend/apps/exports/tests.py |
| POST | /api/history/exports/[id]/items | DJANGO_IMPLEMENTED_LOCAL | backend/apps/exports/tests.py |
| GET | /api/history/exports/[id] | DJANGO_IMPLEMENTED_LOCAL | backend/apps/exports/tests.py |
| POST | /api/history/exports | DJANGO_IMPLEMENTED_LOCAL | backend/apps/exports/tests.py |
| POST | /api/history/move | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| GET | /api/history | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/tests.py |
| PATCH | /api/history | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| DELETE | /api/history | DJANGO_IMPLEMENTED_LOCAL | backend/apps/library/test_organization.py |
| GET | /api/history/updates | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/tests.py |
| GET | /api/media/[...path] | DJANGO_IMPLEMENTED_LOCAL | backend/apps/media/test_media.py |
| GET | /api/media-grant | DJANGO_IMPLEMENTED_LOCAL | backend/apps/media/test_media.py |
| GET | /api/projects | DJANGO_IMPLEMENTED_LOCAL | backend/apps/projects/tests.py |
| POST | /api/projects | DJANGO_IMPLEMENTED_LOCAL | backend/apps/projects/tests.py |
| POST | /api/queue/execute | INTENTIONALLY_RETIRED_LOCAL | backend/apps/generation/test_execution.py |
| GET | /api/queue/status | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/tests.py |
| GET | /api/settings | DJANGO_IMPLEMENTED_LOCAL | backend/apps/admin_dashboard/tests.py |
| POST | /api/uploads/presign | DJANGO_IMPLEMENTED_LOCAL | backend/apps/media/test_media.py |
| GET | /api/users | DJANGO_IMPLEMENTED_LOCAL | backend/apps/authentication/tests.py |
| POST | /api/webhooks/seedance | DJANGO_IMPLEMENTED_LOCAL | backend/apps/generation/test_execution.py |
| POST | /api/worker/depth/claim | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| POST | /api/worker/depth/complete | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| POST | /api/worker/depth/heartbeat | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| POST | /api/worker/depth/progress | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| GET | /api/worker/depth/status | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| POST | /api/worker/depth/upload-url | DJANGO_IMPLEMENTED_LOCAL | backend/apps/workers/tests.py |
| POST | /api/worker/exports/access | DJANGO_IMPLEMENTED_LOCAL | backend/apps/exports/tests.py |

The method registry verifies actual Django URL resolution and declared verbs. Domain tests
cover behavior and negative paths; source links alone are not execution evidence. See
qualification-index.md for commands, complete results and limits. The HTTP schema endpoint
and browser-triggered executor return authenticated 410 responses; schema operations use
controlled Django commands and workers invoke Python services directly.

## Managed model ownership

- admin_dashboard.Pricing: pricing
- admin_dashboard.AppSetting: settings
- admin_dashboard.UserLimit: user_limits
- agents.AgentConversation: agent_conversations
- agents.AgentConversationMessage: agent_conversation_messages
- assets.Asset: assets
- assets.PortraitGroup: portrait_groups
- assets.PortraitAsset: portrait_assets
- authentication.User: users
- authentication.LoginAttempt: login_attempts
- canvas.CanvasBoard: canvas_boards
- common.ActivityLog: activity_logs
- exports.MediaExport: media_exports
- exports.MediaExportItem: media_export_items
- generation.Generation: generations
- library.Folder: folders
- library.OrganizationIdempotencyKey: organization_idempotency_keys
- library.NamingCounter: naming_counters
- library.GenerationNaming: generation_naming
- media.UploadSession: upload_sessions
- projects.Project: projects
- workers.DepthWorker: depth_workers

The model-registry.md artifact records columns, defaults, indexes, checks and foreign keys.
No local result establishes a live provider, hosted proxy or production schema cutover.
