# GCP Migration — Holdoff (2026-07-16)

Work on the database/storage cutover described in `upgrade.md` is **paused here**,
mid-runbook, to go fix a production bug (Canvas board/asset project-context
mismatch) first. This file is the resume point — read this before continuing
the migration.

## Exactly where the runbook stands

Per `upgrade.md`'s "Safe Cutover Runbook" §1 (Initial copy while production
stays online):

- ✅ Local blockers cleared this session:
  - AWS read credentials for `s3://ais-film-platform-media` are live in
    `.env.local` (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/
    `AWS_S3_BUCKET_NAME`) — verified with a `HeadBucket`/`ListObjectsV2` call.
  - Local GCP Application Default Credentials were expired; re-authenticated
    via `gcloud auth application-default login` as `vivek@amazingindianstories.com`.
  - **Environment bug found and fixed**: `npm run migrate:media:gcp` under this
    machine's global Node (v26.3.1) fails every time with
    `GaxiosError: Invalid response body ... Premature close` while refreshing
    the OAuth token — a known `node-fetch@2.7.0`/newer-Node zlib-stream
    incompatibility, bundled transitively inside `google-auth-library-v9`
    (pinned there specifically for `@google-cloud/storage` v7 compat — see the
    comment above `getStorageAuth()` in `src/lib/gcp-auth.ts`). This isn't a
    credentials problem — `curl` to the same endpoint works fine.
  - **Fix**: installed Node 22 via Homebrew, keg-only (`brew install node@22`,
    did **not** run `brew link` — the global `node` symlink is untouched,
    still resolves to v26.3.1). This matches the project's own
    `package.json` `"engines": {"node": "22.x"}` pin. Run migration/verify
    scripts with Node 22 explicitly on `PATH`:
    ```bash
    PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run migrate:media:gcp
    PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run migrate:postgres:gcp
    PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run verify:media:gcp
    ```
- ✅ `npm run migrate:postgres:gcp` (dry run, no `--apply`): succeeded, wrote a
  fresh Railway snapshot to a temp dir. Not yet applied to Cloud SQL.
- ✅ `migrate:media:gcp` dry run (no `--apply`), run under Node 22: succeeded.
  Result:
  ```
  Checking 1613 objects: s3://ais-film-platform-media -> gs://aistudio-media-bucket
  { "same": 0, "missing": 1613, "different": 0, "copied": 0, "failed": 0 }
  ```
  All 1613 currently-referenced media objects are missing from GCS (grew from
  the 508 recorded in `upgrade.md` on 2026-07-14 — production kept writing to
  S3 in the interim, as expected). **Nothing has been copied yet** — this was
  read-only against both S3 and GCS.

## Not yet done (resume here)

1. Run the real copy: `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run migrate:media:gcp -- --apply`
   (writes to GCS only; S3 stays untouched and authoritative; no production
   impact since `MEDIA_BACKEND` stays `s3` throughout this step).
2. `-- --verify-only` and `npm run verify:media:gcp` until zero
   missing/mismatched objects.
3. Everything after that in `upgrade.md`'s runbook §2–6 is still fully
   pending: smoke tests, the final Postgres maintenance-window resync, then
   flipping `DATABASE_BACKEND` and `MEDIA_BACKEND` one at a time (each with a
   redeploy + verify), then the CDN switch.

## Safety notes for whoever resumes this

- `DATABASE_BACKEND=railway` and `MEDIA_BACKEND=s3` are still the live gates in
  both Vercel Production and Preview — nothing about this session's local work
  has touched production behavior.
- The AWS secret key used here was pasted directly into chat by the user
  despite being asked not to; it's now only in `.env.local` (gitignored, never
  committed). Worth flagging to the user that rotating it is good hygiene
  given it passed through a chat transcript.
- Per this repo's own incident history (`main` was reset to a known-good
  baseline on 2026-07-13 after risky in-flight GCP/WIF deploy work), do not
  flip `DATABASE_BACKEND`/`MEDIA_BACKEND` in Production without one explicit,
  separate confirmation at each gate — this holds regardless of any earlier
  blanket "go ahead" on the migration in general.
