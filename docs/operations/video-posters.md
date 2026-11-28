# Video posters

A finished video generation has a poster: the first frame of its master as a 512 px WebP at
`thumbs/poster/<master key>.webp` (`apps/media/posters.py`, create-only, one ffmpeg at a time per process with a 15 s
deadline). `generations.poster` holds its `/api/media/...` reference. The master is never rewritten.

- **New videos.** `services/poller._terminal` makes the poster right after the master is stored, for every provider
  path (Seedance, Omni, OmniHuman, Higgsfield, Magnific). A failure is logged (`video_poster_failed`) and never
  fails the generation nor delays it beyond roughly 30 s (up to 15 s waiting for the process's ffmpeg slot, then the
  15 s ffmpeg deadline); the backfill picks that row up later.
- **Library cards.** A card with a poster paints it and mounts the `<video>` (and fetches the master) only when the
  pointer reaches the card. A card without a poster behaves as before: the `<video>` mounts near the viewport.

## Backfill (owner-approved step, run after the deploy)

```
python backend/manage.py backfill_video_posters --dry-run          # counts rows that would be examined
python backend/manage.py backfill_video_posters --limit 200        # one bounded run
python backend/manage.py backfill_video_posters --limit 200 --after <next from the previous run>
```

Run it in the Railway API container (API database role; the generation worker's storage access is enough, no
provider keys). It selects succeeded video rows with `poster IS NULL` in `(created_at, id)` order, in batches
(`--batch-size`, default 25), with `--workers` concurrent ffmpeg reads (default 1, at most 4). It is safe to repeat
and to interrupt: finished rows no longer match, an existing poster object is only linked (never re-encoded), the
row is updated only while its poster is still NULL, and masters are never written or deleted. A failure or a missing
master is logged (`video_poster_backfill_failed` / `_missing`) and skipped. The final JSON line reports
`examined`, `poster`, `missing`, `failed` and `next`; `next` is the cursor to pass as `--after` (null once the
scan is done). Rows that keep failing (for example a master that no longer exists) stay posterless and are listed
in the log by id; a plain re-run retries them, `--after` skips past them.
