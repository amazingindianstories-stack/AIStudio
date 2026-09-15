# Generation coordinator

PostgreSQL is authoritative for generation state. The Railway worker selects
only queued image/video jobs and running video jobs, claims each with a bounded
database lease, and calls the authenticated Next.js queue route. Depth jobs and
running synchronous image jobs are never selected.

Native BytePlus video submissions include the Seedance callback only when
`SEEDANCE_CALLBACK_URL` is valid HTTPS and `SEEDANCE_CALLBACK_SECRET` is set.
The public middleware exemption only lets the provider reach the route; the
route still fails closed on its callback token. Task IDs are bounded and may be
read from `id`, `task_id`, or `data.id`. Duplicate terminal callbacks only
refresh callback metadata.

Required production-only configuration:

- Web/API: `SEEDANCE_CALLBACK_URL`, `SEEDANCE_CALLBACK_SECRET`, and
  `GENERATION_WORKER_SECRET`.
- Worker: `GENERATION_WORKER_URL` (or `NEXT_PUBLIC_APP_URL`) and the same
  `GENERATION_WORKER_SECRET`.

The browser live feed and delayed queue adoption remain low-frequency fallback
paths. Ably is optional. The coordinator migration is additive and idempotent;
run it and verify `generations_coordinator_due_idx` before deploying code that
reads the new columns.
