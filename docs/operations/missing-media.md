# Missing media - generations whose stored file is gone

What runs in production is recorded in `status.md`; this change is verified locally only. The command below has **not**
been run against production, and running it needs explicit owner approval.

## Why
36 succeeded generations from 2026-09-21/22 (27 Seedream 5.0 Pro, 5 Nano Banana Pro, 4 Seedance 2.0) have no stored master
in `aistudio-media-bucket` (canonical or prefixed key), so their tiles were broken and `/api/media` answered 404. No copy
exists anywhere: no provider URL is kept, the bucket has no versioning or soft delete, and the 32 images only keep lossy
512/1280 WebP thumbnails, which are not valid masters. The four videos have nothing at all.

## The state
`generations.media_missing_at` (nullable bigint, epoch ms, migration `generation.0014`, additive: no default, no backfill).
It is set only when the master was verified absent. Everything else on the row is left alone: status stays `succeeded`,
cost, usage counts, `permanent_name` and the stored `url` do not change, so history, spend and naming are intact.

| Surface | Behaviour |
|---|---|
| Library / history API | the item carries `mediaMissingAt` only when set |
| `GET /api/generations/<id>/download` | `410 MEDIA_MISSING` ("The stored file for this generation is missing, so it cannot be downloaded."), storage is not touched |
| ZIP export | the id is rejected with reason `media_missing` and never archived; other ids in the request proceed |
| MCP original/preview links | no link is made for the item |
| Media card and chat thread card | "File missing" tile. Images show the surviving 512 WebP thumbnail when it loads, otherwise a plain placeholder; videos show the placeholder. The master is never requested. The card has no viewer or download action and cannot be dragged, but can still be favourited, moved or deleted. |
| Viewer | the item is left out of viewer navigation, neighbour preloading and keyboard open (`isNavigable` in `src/lib/viewer-navigation.js`) |

## Command
```
scripts/dev/test-db.sh PYTHON backend/manage.py mark_media_missing --ids-file backend/apps/generation/data/missing_media_2026_09_21.txt
```
Add ids as positional arguments instead of (or as well as) `--ids-file`. An id that is not a UUID stops the command before
anything is checked. The default is a dry run. `--apply` writes.

Per id it reports one of: `would_mark` / `marked` (master absent), `present` (master exists, never marked),
`already_marked` (idempotent re-run, timestamp kept), `skipped` (not succeeded, or no protected media key such as an
external URL or an export archive), `not_found`, `error` (a storage failure is never read as absence; the command then
exits non-zero and nothing is marked for that row). Each row is checked and updated in its own transaction under
`select_for_update`, and the update only applies while the marker is still empty.

`backend/apps/generation/data/missing_media_2026_09_21.txt` holds the 36 ids. It is shipped in the backend image.

## Production procedure (owner approval required)
1. Dry run through `railway ssh` on the API service; expect `would_mark=36`, `present=0`.
2. Apply with `--apply`; the migration must already be deployed.
3. Re-run the dry run: expect `already_marked=36`.
4. Rollback of the marker: `UPDATE generations SET media_missing_at = NULL WHERE id IN (...)` (the data file lists the ids).
