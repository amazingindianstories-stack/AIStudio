# Working on Veevee

Read `AGENTS.md` first. The active blueprint is
`Veevee_Django_Migration_Blueprint_2026-10-08.md`. This branch implements the
Django/Python backend replacement; it is not evidence of a production cutover.
No shared credentials, live provider calls or deployment are authorized by local
qualification.

## Current architecture

Veevee is an internal image/video production application. Next.js and React own
the interface, Zustand owns client state, and same-origin `/api` requests are
forwarded to Django. `DJANGO_API_ORIGIN` is the frontend's server-only transport
setting. Vercel needs no database, session-signing, storage, provider or worker
secrets. There is no browser API-base migration.

The Python backend has separate Django domain apps for authentication, projects,
library/naming, assets/portraits, canvas, agents, generation, exports, workers,
media and administration. The single managed migration graph is under
`backend/apps/*/migrations`. PostgreSQL is required; SQLite is not qualification.

Image/video enqueue endpoints persist queued requests and durable references.
The independent `generation_worker` owns admission, execution, task receipts,
provider polling and terminal state. `GET /api/generate/video/status` is a
read-only resync. The retired browser execution endpoint remains an explicit
contract, rather than silently running provider work in the frontend.

`media_export_worker` builds private archives using frozen manifest filenames.
`run_scheduler` reconciles depth/video work and cleans login attempts/expired
exports, with database slot leases and startup catch-up. External GPU depth
workers continue to use the fenced depth HTTP protocol; they are not Railway
application workers.

## Commands and qualification

Dependency installation is separate from qualification. Backend dependencies are
in `backend/requirements.txt`; frontend packages are in `package.json`.

Use `scripts/django-migration/isolated.py prepare`, then `start-db SESSION`, and
`run SESSION COMMAND ...` for local tests or servers. The runner verifies its
actual cluster and supplies empty HOME/allowlisted environment. Use an explicit
Python interpreter with backend requirements installed. Do not run qualification
against an inherited DATABASE_URL or dotenv file.

Useful commands *inside that verified runner*:

- `python backend/manage.py check`
- `python backend/manage.py makemigrations --check --dry-run`
- `python backend/manage.py migrate --noinput` on a fresh disposable database
- `python backend/manage.py test` (all apps, including media)
- `python scripts/django-migration/browser-harness.py --install-browser`
- `npm run check:backend-ownership`, `npm run lint`, `npm test`, `npm run build`

GitHub CI uses `ci-qualification.py`, which verifies the actual PostgreSQL 16
service container before running a clean copy. Its baseline gate tests committed
fresh migrations, physical catalog equivalence, invariant behavior, populated
history-only adoption, negative drift/history cases and row preservation.
Historical Node outputs are frozen fixtures; runtime qualification does not
execute a retired backend to manufacture expected results.

## Behavior that must remain intact

- Seedance 2.5 outputs native MOV for all task modes, including Draft/finalization.
  Final/High are defaults; explicit artist choices remain authoritative. Preserve
  native bytes and container/MIME/filename through individual and ZIP downloads.
- Session cookies remain DB-validated, versioned, renewed and revocable. Keep
  endpoint-specific machine token and signed media/export grant boundaries.
- Gemini spend admission is separate from concurrency. Its configured budget is
  in the application's estimator cents; do not reinterpret it as provider USD.
  Empty-window forward progress and per-user fairness must survive changes.
- Persist accepted external task IDs before further submissions. A partial
  best-of failure must retain accepted work and prorate cost. Cancellation or
  storage failure must not cause a duplicate billed submission.
- Provider payloads, reference order, tags, timing, errors and cost rules need
  exact tests. Missing credentials do not select mock success. Explicit offline
  fixtures do not prove live provider or hosted-cloud acceptance.
- Preserve protected storage namespaces, bounded fetches, original master bytes,
  separate thumbnails, and native MOV download fallback when a browser cannot
  decode the master. Do not trade master quality for preview compatibility.
- Library scopes are indexed server queries. Keep `(created_at, id)` keysets,
  favorite timestamps, project/global unsorted distinctions and SQL aggregates.
  Never replace totals with the length of a loaded page.
- Frontend cache patches must update every cached scope; do not delete/reinsert
  keys while iterating a live Map. Infinite-scroll appends must not reshuffle
  existing cards. Preserve masonry append stability and buffered live arrivals.
- Canvas graph normalization, UTF-16 size limits, undo grouping, keyboard focus,
  upload grants and autosave behavior are contract-sensitive. Domain services
  live in `backend/apps/canvas`; pure editing geometry stays in the frontend.
- Folder/naming operations preserve IDs, hierarchy, optimistic versions,
  idempotency, serial counters and existing frozen export filenames.

## Deployment state

The proposed topology is Railway Django API + Python generation worker + Python
export worker + scheduler, with a transport-only Vercel frontend. The database and
media stores are preserved. See `DEPLOYMENT_RUNBOOK.md` and
`docs/django-migration/cutover-runbook.md`. Production schema/history adoption,
traffic transfer, hosted smoke tests, provider acceptance and secret removal are
UNEXECUTED until separately authorized and evidenced. Historical deployed
Drizzle ownership is recorded separately from local Django authority.
