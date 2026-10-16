# Working on Veevee

Read `AGENTS.md` first. `docs/architecture/overview.md` maps the services and code;
`docs/operations/status.md` is the current production record (what runs where, incidents, owner
approval gates). Nothing in a local session authorizes deploys, pushes, production data access
or live provider calls; the owner approves each one.

## Current architecture

Next.js and React own the interface, Zustand owns client state, and `src/middleware.js` forwards
same-origin `/api` requests to Django with a server-only ingress header. Vercel holds only
`DJANGO_API_ORIGIN` and `GOAL4_PRIVATE_INGRESS_SECRET`; no database, storage, provider or
session-signing secrets.

Railway Green runs the Django API behind `backend/deploy/gateway.py`, plus the generation worker,
export worker and scheduler, all started by `python -m deploy.entrypoint <component>` from
`backend/Dockerfile`. `docs/operations/status.md` records the commit and deployment each service
runs and its rollback target. Magnific image/video upscaling is behind `VEEVEE_MAGNIFIC_UPSCALE`.
The single managed migration graph is under `backend/apps/*/migrations`; PostgreSQL only.

Image/video enqueue endpoints persist queued requests and durable references. The
`generation_worker` owns admission, execution, task receipts, provider polling and terminal
state. `GET /api/generate/video/status` is a read-only resync. `media_export_worker` builds
private archives using frozen manifest filenames. `run_scheduler` reconciles depth/video work,
cleans login attempts and expired exports, and runs the portrait janitor, with database slot
leases and startup catch-up. External GPU depth workers use the fenced depth HTTP protocol.

`apps/production_runtime` installs the Green production policies (paid guard, export admission,
lease/naming namespaces, portrait lifecycle) by patching other modules at startup. Renaming or
reshaping a patched function can break API startup; check that app before refactoring the
modules it touches.

## Commands

- Frontend: `npm test`, `npm run lint`, `npm run build`.
- Backend on a throwaway PostgreSQL 18.6 with an allowlisted environment:
  `scripts/dev/test-db.sh PYTHON backend/manage.py test backend` (or an app label).
- Browser suite through Django: `scripts/dev/test-db.sh PYTHON scripts/dev/browser-harness.py`.
- Whole stack locally: `local/veevee.sh up|user|frontend` (see `local/README.md`). Run
  `local/veevee.sh user` only from one checkout; it resets the shared local admin password.
- Release qualification: `scripts/release/release_gate.sh <commit>` and
  `scripts/release/rehearse_local.sh <commit>`; staging refuses a commit without both passes.

`PYTHON` needs `backend/requirements.txt` (with `backend/constraints-qualified.txt`). Native runs
need Docker, Node 22+, ffmpeg and libvips. CI (`.github/workflows/ci.yml`) mirrors the release gate.

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
  fixtures do not prove live provider acceptance.
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
