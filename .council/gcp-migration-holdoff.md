# GCP Migration — Status and Postgres Cutover Runbook (updated 2026-07-23)

## Media (S3 → GCS): DONE, live in production

- `MEDIA_BACKEND=gcs` and `GCS_MIGRATION_READ_FALLBACK=1` are set in Vercel
  Production and deployed (2026-07-23).
- Full copy completed and verified directly against real GCS/S3 object counts
  (not just the script's own self-report). Residual drift after each pass was
  confirmed to be new objects from live production traffic, not copy failures.
- `GCS_MIGRATION_READ_FALLBACK=1` means any read that 404s on GCS transparently
  falls back to S3 — so even if a handful of objects haven't been backfilled
  yet, nothing breaks for users. New writes go straight to GCS
  (`saveBuffer`/`uploadBuffer` in `src/lib/storage.ts` check `MEDIA_BACKEND`).
- Verified live on production (`www.veevee.ai`): existing images across
  multiple projects load correctly; a real test generation was confirmed
  present in the GCS bucket immediately after creation (test project +
  generation were cleaned up afterward).
- Rollback if ever needed: flip `MEDIA_BACKEND` back to `s3` and redeploy.
  Nothing is ever deleted from S3, so this is instant and lossless.
- Follow-up, not urgent: run `npm run verify:media:gcp` again until it reports
  0 missing, then `GCS_MIGRATION_READ_FALLBACK` can be turned off (leaving it
  on is harmless either way).

## Postgres (Railway → Cloud SQL): NOT started — scheduled for tomorrow morning, low-traffic window

Unlike media, this cannot use a "flip then backfill" trick — the app reads
*and* writes through whichever backend `DATABASE_BACKEND` points at, and
there's no equivalent of the GCS read-fallback for Postgres. The cutover must
be atomic: freeze writes (in practice, do it while no one is online), take a
fresh consistent snapshot, import it, verify, then flip.

### What `migrate:postgres:gcp` actually does

`scripts/migrate-postgres-to-cloud-sql.ts`:
1. `pg_dump` the full Railway DB to a local temp file (`--clean --if-exists`,
   so importing **drops and recreates every object** from a clean snapshot —
   this is a full replace, not an incremental merge).
2. Appends hardening SQL: runtime IAM grants + the same performance indexes
   added during the original migration prep.
3. Without `--apply`: stops after the local dump (pure dry run, touches
   nothing in GCP).
4. With `--apply`: uploads the dump to `gs://<bucket>/migrations/...` and runs
   `gcloud sql import sql` into the Cloud SQL instance/database.

Because it's a clean replace, **whatever's currently in Cloud SQL doesn't
matter** — the import fully overwrites it with a fresh Railway snapshot at
cutover time. No incremental diffing needed on this side (unlike media).

### Pre-flight completed today (2026-07-23), zero risk, nothing touched in GCP

- Confirmed local `pg_dump` is v18.4 (Homebrew), matching Cloud SQL's engine
  version (v18.4 Enterprise per `upgrade.md`) — no version-mismatch risk.
- Ran the dry run (`npm run migrate:postgres:gcp`, no `--apply`): succeeded in
  ~24s, produced a clean local snapshot. Confirms Railway connectivity and the
  pg_dump command both work end-to-end right now.
- Confirmed there are no Vercel cron jobs (`vercel.json` has none) that could
  write to the DB unattended overnight — the only writes come from active
  user sessions / in-flight generations, which should be zero during a
  no-users-online window.
- Current Railway row counts (baseline, captured 2026-07-23, for post-import
  comparison):
  ```
  users: 12          projects: 4         folders: 4
  generations: 607   assets: 0           pricing: 10
  canvas_boards: 12  activity_logs: 770
  ```
- Did **not** attempt to read Cloud SQL's current row counts locally — that
  needs the runtime service account's IAM DB user via Workload Identity
  Federation, which only works inside the actual Vercel runtime, not from a
  local machine. Not needed anyway, since the import is a full replace.

### Known risk for tomorrow: GCP auth may need a fresh login again

Twice today, both `gcloud auth application-default login` (ADC, used by the
Node/`@google-cloud/*` SDKs) and `gcloud auth login` (the separate CLI login,
used when a script shells out to `gcloud` directly) expired mid-session with
`invalid_grant`/`invalid_rapt` (a Google Workspace reauth requirement) or a
plain "Reauthentication failed" CLI error. **`migrate-postgres-to-cloud-sql.ts`
shells out to `gcloud storage cp` and `gcloud sql import` directly**, so it
needs `gcloud auth login` to be fresh at cutover time — assume it will need
re-running tomorrow morning (`gcloud auth login` via the `!` prefix) rather
than relying on today's session carrying over.

### Runbook for tomorrow (early morning, no users online)

1. **Re-auth if needed**: `!gcloud auth login` (and `!gcloud auth application-default login`
   if any ADC-based check is also run). Confirm with `gcloud storage ls gs://aistudio-media-bucket`
   (lightweight, read-only) that the CLI session is live before proceeding.
2. **Confirm quiet**: check the admin dashboard / activity_logs for any
   in-flight generations (`status: running/queued`) before starting — ideally
   zero.
3. **Run the real import**: `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run migrate:postgres:gcp -- --apply`
   (Node 22 required — same node-fetch/Node 26 incompatibility as the media
   script applies here too, since it shares `gcp-auth.ts`).
4. **Verify row counts match** between Railway (baseline above, re-check it
   hasn't changed) and Cloud SQL post-import, for all 8 tables.
5. **Flip** `DATABASE_BACKEND=cloud-sql` in Vercel Production (`vercel env rm`
   + `vercel env add`, same pattern used for the media flip), then
   `vercel deploy --prod` to redeploy.
6. **Smoke test immediately**: log in, view existing projects/generations
   (confirms reads work), create one test generation (confirms writes work
   and lands correctly), check `/admin` status page's Postgres check.
7. **Rollback plan**: flip `DATABASE_BACKEND` back to `railway` + redeploy.
   Safe as long as it's caught quickly — any writes that land in Cloud SQL
   after the flip but before a rollback would need to be manually
   re-applied to Railway, so don't delay verification in step 6.
8. Once confirmed stable, remaining `upgrade.md` items: CDN switch-over
   (media, cosmetic/perf only, not urgent), and eventually decommissioning
   the Railway instance once confidence is high (not before Cloud SQL has run
   cleanly for a while).

## Safety notes

- Per this repo's own incident history (`main` was reset to a known-good
  baseline on 2026-07-13 after risky in-flight GCP/WIF deploy work), do not
  flip `DATABASE_BACKEND` in Production without explicit, separate
  confirmation at the time — a general "go ahead with the migration"
  discussion earlier does not count as that confirmation.
- The AWS secret key was pasted directly into chat by the user earlier this
  project despite being asked not to; still only in `.env.local` (gitignored,
  never committed). Rotating it is good hygiene since it passed through a
  chat transcript — still not done as of this update.
