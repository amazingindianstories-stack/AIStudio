# Board and project roles

Who may open, edit, share and own a canvas board. Django decides every case in
`backend/apps/canvas/access.py`; the frontend only hides what the server would refuse.

## Roles

| Source | Values | Stored in |
|---|---|---|
| Team access (every signed-in teammate) | `edit`, `comment`, `view` | `canvas_boards.team_role`, default `edit` |
| Board member | `edit`, `comment`, `view` | `board_members (board_id, user_id, role)` |
| Project member (applies to every board in the project) | `owner`, `co_owner`, `editor`, `commenter`, `viewer` | `project_members (project_id, user_id, role)` |
| Board owner | one per board | `canvas_boards.created_by` |
| Admin | full rights everywhere | `users.role = 'admin'` |

The effective role is the highest of these, ranked view < comment < edit < co-owner < owner.
Board ownership, the admin role and the project `owner` role all rank as owner; project `co_owner`
ranks as co-owner.

| Action | Needs | Route |
|---|---|---|
| List the board, open it, see who has access | view | `GET /api/canvas-boards`, `GET /api/canvas-boards/<id>`, `GET /api/canvas-boards/<id>/version`, `GET /api/canvas-boards/<id>/changes`, `GET /api/canvas-boards/<id>/access` |
| Save the graph, upload media, read the board history | edit | `PUT` and `PATCH /api/canvas-boards/<id>`, `POST /api/canvas-boards/<id>/upload`, `GET /api/canvas-boards/<id>/activity` (`board-history.md`) |
| Create with AI: quote, run, list and place jobs | edit | `/api/canvas-boards/<id>/ai-jobs` and its `quote` and `<jobId>` routes |
| Set a protected lock (held by the setter; only they may change, unlock or delete the object), set the board start view | co-owner | `PUT` and `PATCH /api/canvas-boards/<id>`; a save that tries it below co-owner keeps its other changes (`backend/apps/canvas/locks.py`) |
| Rename, add/change/remove board members | co-owner | `renameBoard`; `setMember`, `removeMember` on `/access` |
| Delete, set team access, transfer ownership | owner | `deleteBoard`; `setTeamRole`, `transferOwner` on `/access` |

A user below view gets 404 for the board; a user below the needed role gets 403 `FORBIDDEN`.
Role checks run before body validation and the version check, so a refused save never gets a 409
with the graph (`../architecture/canvas-board-sync.md`). Access changes touch neither `updated_at` nor
the board `version`. Board list and detail responses carry the caller's `role`.

Transferring ownership sets `created_by` to the new owner, drops the new owner's board membership
and keeps the previous owner on the board as an editor.

Creating a board (`createBoard` on `POST /api/canvas-boards`) stays team-wide while a project has no
project members, or only its creator's (`projects.created_by`) owner row: any signed-in teammate may
create a board there. Once anyone else is added to the project, creating a board needs project editor
or above; admins may always create. A refused creation gets 403 `FORBIDDEN`. The creator owns the new
board. Every board list response (`GET /api/canvas-boards` and the `createBoard`, `renameBoard` and
`deleteBoard` replies) carries `canCreate` for the caller and project.

Project roles are changed through `GET`/`POST /api/projects/<id>/members` (`setMember`, `removeMember`).
Project owners and admins manage every role; co-owners manage roles below owner. Creating a project
makes its creator the project owner. Deleting a board, project or user removes its memberships.

## Upgrade default

Migrations `canvas.0002_board_roles` and `projects.0002_project_members` are additive. Every existing
and new board starts with team access `edit` and no members, so every signed-in teammate keeps
today's open and save access, and only the board owner and admins rename and delete, as before.
Existing projects get no project roles, and a new project only its creator's owner row, so every
teammate keeps creating boards there. An owner narrows access from the share dialog.

## Frontend

`src/components/canvas/BoardShareDialog.jsx` (the Share button beside the board switcher) shows the
owner, team access, board members and project roles, and lets each caller change what their role
allows. It offers only active teammates (`isActive` on `GET /api/users`) to add. View-only and
comment-only users get a read-only canvas: navigation and zoom only, no creation tools, style
inspector, drops, pastes, text or crop editing, and no autosave (`selectReadOnly` in
`src/lib/canvas-store.js`). A save refused with 403 turns the open board
read-only and keeps the unsaved edits in the local pending draft. The board switcher
(`src/components/canvas/BoardSwitcher.jsx`) offers New board only with `canCreate` and says why when a
creation is refused. A project with no boards that the caller cannot add to, including after they delete
its last board, shows one empty state on the canvas instead of creating a board, with the toolbar, Share
and save status hidden. The canvas store ignores graph edits while no board is open.
