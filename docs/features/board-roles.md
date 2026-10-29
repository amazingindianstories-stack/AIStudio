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
| List the board, open it, see who has access | view | `GET /api/canvas-boards`, `GET /api/canvas-boards/<id>`, `GET /api/canvas-boards/<id>/access` |
| Save the graph, upload media | edit | `PUT /api/canvas-boards/<id>`, `POST /api/canvas-boards/<id>/upload` |
| Rename, add/change/remove board members | co-owner | `renameBoard`; `setMember`, `removeMember` on `/access` |
| Delete, set team access, transfer ownership | owner | `deleteBoard`; `setTeamRole`, `transferOwner` on `/access` |

A user below view gets 404 for the board; a user below the needed role gets 403 `FORBIDDEN`.
Role checks run before body validation. Access changes do not touch `updated_at`, which versions
the graph. Board list and detail responses carry the caller's `role`.

Transferring ownership sets `created_by` to the new owner, drops the new owner's board membership
and keeps the previous owner on the board as an editor.

Creating a board (`createBoard` on `POST /api/canvas-boards`) needs project editor or above once the
project has explicit project members, and admins may always create. A project without project members
stays team-wide: any signed-in teammate may create a board there. A refused creation gets 403
`FORBIDDEN`. The creator owns the new board.

Project roles are changed through `GET`/`POST /api/projects/<id>/members` (`setMember`, `removeMember`).
Project owners and admins manage every role; co-owners manage roles below owner. Creating a project
makes its creator the project owner. Deleting a board, project or user removes its memberships.

## Upgrade default

Migrations `canvas.0002_board_roles` and `projects.0002_project_members` are additive. Every existing
and new board starts with team access `edit` and no members, so every signed-in teammate keeps
today's open and save access, and only the board owner and admins rename and delete, as before.
Existing projects get no project roles, so every teammate keeps creating boards there. An owner narrows
access from the share dialog.

## Frontend

`src/components/canvas/BoardShareDialog.jsx` (the Share button beside the board switcher) shows the
owner, team access, board members and project roles, and lets each caller change what their role
allows. It offers only active teammates (`isActive` on `GET /api/users`) to add. View-only and
comment-only users get a read-only canvas: navigation and zoom only, no creation tools, style
inspector, drops, pastes, text or crop editing, and no autosave (`selectReadOnly` in
`src/lib/canvas-store.js`). A save refused with 403 turns the open board
read-only and keeps the unsaved edits in the local pending draft.
