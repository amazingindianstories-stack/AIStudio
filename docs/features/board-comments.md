# Board comments, notifications and Web Push

Comment threads pinned to a board, @mentions, the notification bell, who is on the board now, and
optional browser push. Who may do what is in [board-roles.md](board-roles.md); co-editing and live
cursors are not part of this.

## Comments (`backend/apps/canvas/comments.py`)

A thread is a root comment pinned to a node (with an offset, so it moves with the node) or to board
coordinates; replies hang off the root. Limits: 4,000 characters per comment, 500 live replies per thread
and 3,000 live comments per board (a full load returns at most that many, so it never drops the newest).
Roots carry an optional pin color; reactions are a fixed set of 12 emoji, toggled per person.

- Only a comment's author changes its words. Moving a pin needs the author or edit access, and never
  changes the words. The author, or a co-owner or owner, deletes it; deleting a root deletes its replies.
- Deleted comments stay as tombstones for 24 hours so polls can drop them, then the next new thread on the
  board prunes them, with presence rows older than a day.
- Read state is per person and comment (`comment_reads`); your own comments are always read. Opening a
  thread marks it read; a thread can be marked unread again, and every comment on the board read.
- Unsent drafts stay in the browser (`localStorage`, `src/lib/canvas/comments.js`), never on the server.

## Mentions

A mention is stored in the body as `@[Name](user:<id>)`, or `@[board](board)`, `@[team](team)` and
`@[space](space)` for groups: everyone who has commented on or been given the board plus its owner,
every active teammate (at most 500), and the board's project. Mention suggestions are people you mentioned
on this board before, newest first, then its other comment authors.

Board team access is never narrower than view (`setTeamRole` refuses `none`), so everyone a mention reaches
can open the board it names.

## Notifications (`backend/apps/canvas/notifications.py`)

Rows are written inside the comment's transaction. A person gets at most one row per comment: a mention
beats a reply, a reply beats a new-comment notice, and nobody is notified of their own comment.

- Being mentioned by name follows the thread, so its later replies reach you. A group mention notifies
  each person it reaches once and does not follow the thread.
- Replies notify the thread's followers; new threads notify people following every thread on the board.
  Commenting follows your own thread.
- An edit notifies only people it newly reaches: an existing reply or new-comment notice becomes one unread
  mention, and people it newly names follow the thread. Edits rewrite every row's snippet; deleting a
  comment removes the rows that quote it.
- `GET /api/notifications[?boardId=&before=&unread=1&boards=1]` pages 30 rows newest first with a
  140-character snippet, board name and project; `boards=1` adds the boards with activity and their unread
  counts. `POST /api/notifications/read` marks ids, one board, or everything read.
- `run_scheduler` deletes rows older than 30 days (the daily 03:17 UTC `notifications` slot). Deleting a
  board deletes its comments, follows, presence and notifications.

## Polling and presence

An open board runs a second poll beside the version poll, on the same active and idle cadence
(`src/lib/canvas/use-board-polling.js`): `POST /api/canvas-boards/<id>/pulse?since=<previous now>` records the
caller as present and returns `{now, people, comments, unread}` - everyone seen in the last 30 seconds,
comments changed since the previous poll (with a 2.5-second overlap, tombstones included) and the unread
notification count.

## Web Push (`backend/apps/canvas/push.py`, `public/sw.js`)

Off unless the API and scheduler both have `VEEVEE_WEB_PUSH_PUBLIC_KEY`, `VEEVEE_WEB_PUSH_PRIVATE_KEY`
(VAPID P-256, unpadded base64url) and `VEEVEE_WEB_PUSH_SUBJECT` (`mailto:` or `https:`); the production
launcher passes them to those two services only (`backend/deploy/legacy_config.py`). Without them
`POST /api/push-subscription` answers 409.

- Subscriptions are accepted only for the browsers' own push services (`PUSH_HOST_SUFFIXES`).
- Every 5 seconds the scheduler's `push` slot sends each person with notifications from the last 10
  minutes not yet pushed one empty VAPID-signed push, at most 100 subscriptions per tick; people past the cap
  stay pending. Endpoints answering 404 or 410 are dropped.
- Pushes carry no content. The service worker fetches the newest unread notification from the API and
  shows that, so no comment text passes through a third-party push service. Clicking it opens the board
  thread, in an open window when there is one.

## Interface (`src/components/canvas/collab/`)

`CollabLayer` mounts the comment pins and thread cards, the comments panel, the people bar and the
notification bell on an open board. Pins show unread threads, follow their node and can be dragged by
editors and authors. The bell lists notifications across boards or for one board and opens the thread
from a notification or a push. The share dialog's collaboration tools setting (every editor, or co-owners
and owners) is stored on the board as `collab_tools`.
