# GCP Migration — Status, Postgres Cutover Post-Mortem, and Retry Plan (updated 2026-07-27)

## Media (S3 → GCS): DONE, live in production

- `MEDIA_BACKEND=gcs` and `GCS_MIGRATION_READ_FALLBACK=1` are set in Vercel
  Production and deployed (2026-07-23). Still correct as of 2026-07-27.
- `GCS_MIGRATION_READ_FALLBACK=1` means any read that 404s on GCS transparently
  falls back to S3, so residual copy gaps never break users. New writes always
  go to GCS.
- Rollback if ever needed: flip `MEDIA_BACKEND` back to `s3` and redeploy.
  Nothing is ever deleted from S3, so this is instant and lossless.
- **Open item**: `npm run verify:media:gcp` on 2026-07-27 reported **37 missing
  objects** (referenced by the DB, not yet in GCS). Users are unaffected — the
  S3 fallback serves them. But this means **AWS is still a live production
  dependency**, and the AWS key that was pasted into chat is still unrotated.
  Finish with `npm run migrate:media:gcp -- --apply` (needs working ADC), then
  re-verify to 0, then turn the fallback off, then rotate the key.

## Postgres (Railway → Cloud SQL): ATTEMPTED 2026-07-27, ROLLED BACK

**Current state: production is on Railway (`DATABASE_BACKEND=railway`) and
healthy. Do not retry the cutover until the issue below is resolved.**

### Timeline

- 09:44 IST — imported Railway snapshot into Cloud SQL, flipped
  `DATABASE_BACKEND=cloud-sql`, redeployed.
- 09:47 IST — smoke test passed. The login route returned `401` for a bogus
  credential; that route has **no try/catch around the query**, so a DB failure
  would have produced a 500. The 401 genuinely proved the DB was working.
- 12:05–13:06 IST — 25 real user generations ran successfully against Cloud SQL.
- ~13:10 IST — generations began failing with HTTP 500.
- 13:16 IST — rolled back to `railway` + redeployed. Service restored.
- ~14:00 IST — recovered the 25 stranded generations into Railway (below).

### Root cause: connector client-certificate failure after hours of uptime

```
SSL routines:ssl3_read_bytes:ssl/tls alert bad certificate  (SSL alert 42)
ERR_SSL_SSL/TLS_ALERT_BAD_CERTIFICATE
```

Alert 42 is the **server rejecting the client certificate** that
`@google-cloud/cloud-sql-connector` (v1.11.2) presents. Critically, this was
**not** a static misconfiguration — the DB worked for ~3.5 hours first. It is
time-dependent: the connector's short-lived ephemeral client certificate
expiring and failing to refresh in warm serverless instances. This matches a
known class of `bad_certificate` reports against Cloud SQL connectors that
surface "after a few hours":
https://github.com/GoogleCloudPlatform/cloud-sql-jdbc-socket-factory/issues/1314

**The operational lesson: a smoke test immediately after the flip cannot catch
this.** Any retry needs hours of soak time before it can be trusted.

Note `sslMode: TRUSTED_CLIENT_CERTIFICATE_REQUIRED` was initially suspected but
is *not* confirmed as the cause — per Google's docs, IAM-authenticated
connections via the Connectors are supposed to satisfy that mode automatically.
Do not "fix" it by weakening sslMode without first reproducing the failure.

### Before retrying, resolve at least one of

1. Upgrade `@google-cloud/cloud-sql-connector` and `pg`, and confirm the
   ephemeral-cert refresh path works on a long-lived warm instance.
2. Soak-test on a **preview deployment** pointed at Cloud SQL for >6 hours
   under periodic traffic, and confirm no `bad_certificate` appears, BEFORE
   touching production again.
3. Consider whether serverless + connector is the right shape at all; the
   Cloud SQL Auth Proxy as a sidecar is not available on Vercel.

### Data recovery performed (2026-07-27)

While production ran on Cloud SQL, 25 generations + 28 activity_logs were
written there and were therefore invisible after the rollback (their **images
were safe in GCS** the whole time — only the DB rows were stranded).

Recovery method, repeatable if this ever happens again:
1. `gcloud sql export csv <instance> gs://<bucket>/x.csv --query="select row_to_json(t) from <table> t"`
   — exports as one JSON object per line, avoiding all CSV escaping problems.
   Requires granting the **instance service agent**
   (`gcloud sql instances describe --format="value(serviceAccountEmailAddress)"`)
   write access to the target bucket. Use a **dedicated bucket**, never the
   media bucket — see the `settings/`/`migrations/` prefix warning in CLAUDE.md.
2. Diff by primary key against Railway, insert only missing ids with
   `on conflict (id) do nothing`. Never update/delete existing rows.
3. Verify the missing count returns 0, then delete the export bucket (this also
   drops the IAM binding) since the exports contain full user data.

Result: Railway went 784 → 809 generations, 961 → 989 activity_logs, 0 missing.
No canvas_boards diverged.

### Script bug found and fixed (commit `6ee58cb`)

The first import silently left the DB **missing all seven performance indexes**.
`pg_dump` emits `set_config('search_path', '', false)` and fully-qualifies its
own objects, so the hardening SQL appended by
`scripts/migrate-postgres-to-cloud-sql.ts` ran with an empty search_path. The
GRANTs survived (explicitly schema-qualified) but the first `CREATE INDEX`
aborted the import. Fixed by adding `SET search_path TO "public";`.

Watch for this pattern: the import reported data loaded correctly, so the DB
*looked* complete while being badly unindexed.

## Infrastructure audit findings (2026-07-27)

Verified healthy:
- Backups enabled, 14 retained, **point-in-time recovery on**, 7-day
  transaction log retention.
- All env vars `db.ts` requires are present and correct.
- `DB_POOL_MAX=2`, `allowExitOnIdle` — appropriate for serverless.
- Code is properly abstracted: `DATABASE_URL`/`DATABASE_BACKEND` appear only in
  `src/lib/db.ts`; health checks go through backend-agnostic `getDb()`.
- **Deletion protection: ENABLED 2026-07-27** (was off).

Outstanding risks:
- **Tier is `db-f1-micro`** — 614 MiB RAM, *shared-core* (burstable CPU that
  throttles), low default connection cap. Google does not recommend shared-core
  for production. Given this app already hit user-visible freezes from DB
  connection exhaustion, this is the most likely long-term failure source.
  Upgrade before any serious retry.
- `availabilityType: ZONAL` — no automatic failover.
- **Preview env is divergent**: preview runs `railway` + `s3` while production
  runs GCS media. A passing preview no longer proves production works. This is
  also why preview is a usable place to soak-test the Cloud SQL path.

## Safety notes

- Do not flip `DATABASE_BACKEND` in Production without explicit, separate
  confirmation at the time — a general "go ahead with the migration"
  discussion earlier does not count. (Reaffirmed by the 2026-07-27 incident:
  the flip itself was authorized, but the failure mode was invisible to the
  verification available at flip time.)
- GCP auth expires constantly. Both `gcloud auth login` and
  `gcloud auth application-default login` needed re-running on 2026-07-27, and
  the ADC one silently did not take the first time — **check the credential
  file's mtime** (`~/.config/gcloud/application_default_credentials.json`), do
  not trust "it said it worked".
- `migrate-postgres-to-cloud-sql.ts` shells out to `gcloud` only (no Google
  SDK), so it needs the **CLI** login, not ADC. The media scripts need ADC.
- The AWS secret key pasted into chat earlier is still unrotated.
