# API inventory

Source-derived initial inventory. Each method requires behavioral qualification before ownership transfer. GET is not proof of read-only behavior.

| Path | Explicit methods | Source | Qualification |
|---|---|---|---|
| `/api/admin/activity` | GET | `src/app/api/admin/activity/route.js` | Pending |
| `/api/admin/audit/runtime` | POST | `src/app/api/admin/audit/runtime/route.js` | Pending |
| `/api/admin/data` | GET | `src/app/api/admin/data/route.js` | Pending |
| `/api/admin/limits` | POST | `src/app/api/admin/limits/route.js` | Pending |
| `/api/admin/logs` | GET | `src/app/api/admin/logs/route.js` | Pending |
| `/api/admin/migrate-schema` | POST | `src/app/api/admin/migrate-schema/route.js` | Pending |
| `/api/admin/pricing` | POST | `src/app/api/admin/pricing/route.js` | Pending |
| `/api/admin/set-token` | POST | `src/app/api/admin/set-token/route.js` | Pending |
| `/api/admin/status` | GET | `src/app/api/admin/status/route.js` | Pending |
| `/api/admin/user-limits` | POST | `src/app/api/admin/user-limits/route.js` | Pending |
| `/api/admin/users` | POST, PATCH, DELETE | `src/app/api/admin/users/route.js` | Pending |
| `/api/agent-conversations/[id]/messages/[messageId]` | PATCH | `src/app/api/agent-conversations/[id]/messages/[messageId]/route.js` | Pending |
| `/api/agent-conversations/[id]/messages` | POST | `src/app/api/agent-conversations/[id]/messages/route.js` | Pending |
| `/api/agent-conversations/[id]` | GET | `src/app/api/agent-conversations/[id]/route.js` | Pending |
| `/api/agent-conversations` | GET, POST | `src/app/api/agent-conversations/route.js` | Pending |
| `/api/assets/portraits/[id]/assets` | GET, POST, DELETE | `src/app/api/assets/portraits/[id]/assets/route.js` | Pending |
| `/api/assets/portraits` | GET, POST, PATCH, DELETE | `src/app/api/assets/portraits/route.js` | Pending |
| `/api/assets/portraits/upload` | POST | `src/app/api/assets/portraits/upload/route.js` | Pending |
| `/api/assets` | GET, POST, DELETE | `src/app/api/assets/route.js` | Pending |
| `/api/audio/transcribe` | POST | `src/app/api/audio/transcribe/route.js` | Pending |
| `/api/auth/login` | POST | `src/app/api/auth/login/route.js` | Pending |
| `/api/auth/logout` | POST | `src/app/api/auth/logout/route.js` | Pending |
| `/api/auth/me` | GET, PATCH | `src/app/api/auth/me/route.js` | Pending |
| `/api/auth/password` | PATCH | `src/app/api/auth/password/route.js` | Pending |
| `/api/canvas-boards/[id]` | GET, PUT | `src/app/api/canvas-boards/[id]/route.js` | Pending |
| `/api/canvas-boards/[id]/upload` | POST | `src/app/api/canvas-boards/[id]/upload/route.js` | Pending |
| `/api/canvas-boards` | GET, POST | `src/app/api/canvas-boards/route.js` | Pending |
| `/api/cron/depth-reconciliation` | GET | `src/app/api/cron/depth-reconciliation/route.js` | Pending |
| `/api/cron/login-attempts` | GET | `src/app/api/cron/login-attempts/route.js` | Pending |
| `/api/cron/video-reconciliation` | GET | `src/app/api/cron/video-reconciliation/route.js` | Pending |
| `/api/folders` | GET, POST, PATCH, DELETE | `src/app/api/folders/route.js` | Pending |
| `/api/generate/depth` | POST | `src/app/api/generate/depth/route.js` | Pending |
| `/api/generate/depth/status` | GET | `src/app/api/generate/depth/status/route.js` | Pending |
| `/api/generate/image` | POST | `src/app/api/generate/image/route.js` | Pending |
| `/api/generate/upscale` | POST | `src/app/api/generate/upscale/route.js` | Pending |
| `/api/generate/upscale/status` | GET | `src/app/api/generate/upscale/status/route.js` | Pending |
| `/api/generate/video/finalize` | POST | `src/app/api/generate/video/finalize/route.js` | Pending |
| `/api/generate/video` | POST | `src/app/api/generate/video/route.js` | Pending |
| `/api/generate/video/status` | GET | `src/app/api/generate/video/status/route.js` | Pending |
| `/api/generations/[id]/download` | GET, HEAD | `src/app/api/generations/[id]/download/route.js` | Pending |
| `/api/history/counts` | GET | `src/app/api/history/counts/route.js` | Pending |
| `/api/history/exports/[id]/download` | GET | `src/app/api/history/exports/[id]/download/route.js` | Pending |
| `/api/history/exports/[id]/finalize` | POST | `src/app/api/history/exports/[id]/finalize/route.js` | Pending |
| `/api/history/exports/[id]/items` | POST | `src/app/api/history/exports/[id]/items/route.js` | Pending |
| `/api/history/exports/[id]` | GET | `src/app/api/history/exports/[id]/route.js` | Pending |
| `/api/history/exports` | POST | `src/app/api/history/exports/route.js` | Pending |
| `/api/history/move` | POST | `src/app/api/history/move/route.js` | Pending |
| `/api/history` | GET, PATCH, DELETE | `src/app/api/history/route.js` | Pending |
| `/api/history/updates` | GET | `src/app/api/history/updates/route.js` | Pending |
| `/api/media/[...path]` | GET | `src/app/api/media/[...path]/route.js` | Pending |
| `/api/media-grant` | GET | `src/app/api/media-grant/route.js` | Pending |
| `/api/projects` | GET, POST | `src/app/api/projects/route.js` | Pending |
| `/api/queue/execute` | POST | `src/app/api/queue/execute/route.js` | Pending |
| `/api/queue/status` | GET | `src/app/api/queue/status/route.js` | Pending |
| `/api/settings` | GET | `src/app/api/settings/route.js` | Pending |
| `/api/uploads/presign` | POST | `src/app/api/uploads/presign/route.js` | Pending |
| `/api/users` | GET | `src/app/api/users/route.js` | Pending |
| `/api/webhooks/seedance` |  | `src/app/api/webhooks/seedance/route.js` | Pending |
| `/api/worker/depth/claim` | POST | `src/app/api/worker/depth/claim/route.js` | Pending |
| `/api/worker/depth/complete` | POST | `src/app/api/worker/depth/complete/route.js` | Pending |
| `/api/worker/depth/heartbeat` | POST | `src/app/api/worker/depth/heartbeat/route.js` | Pending |
| `/api/worker/depth/progress` | POST | `src/app/api/worker/depth/progress/route.js` | Pending |
| `/api/worker/depth/status` | GET | `src/app/api/worker/depth/status/route.js` | Pending |
| `/api/worker/depth/upload-url` | POST | `src/app/api/worker/depth/upload-url/route.js` | Pending |
| `/api/worker/exports/access` | POST | `src/app/api/worker/exports/access/route.js` | Pending |
