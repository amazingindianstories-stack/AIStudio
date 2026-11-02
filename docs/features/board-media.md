# Board media, files and embeds

Files, embeds, link cards, code blocks, emoji, icons and per-object links on canvas boards. Each is a
format v1 node type (`audio`, `video`, `pdf`, `embed`, `linkcard`, `code`, `emoji`, `icon`) or the optional
`link` field any object may carry. The twin serializers, `src/lib/canvas/media-nodes.js` and
`backend/apps/canvas/media_nodes.py`, coerce them the same way, held together by the shared cases in
`backend/apps/canvas/fixtures/format_v1_media.json`.

## Files

- Uploads use the `canvas` upload purpose (`backend/apps/media/uploads.py`): raster images, SVG, flattened
  PSD, PDF, video (MP4, MOV, WebM) and audio, at most 256 MiB each. Every upload is sniffed against its
  declared type.
- `BoardMedia` rows (`backend/apps/canvas/models.py`) record each stored file. Video, audio and raster
  images are ready at once and keep their original bytes. SVG, PSD and PDF are queued and rendered by the
  generation worker, one file at a time per process (`backend/apps/canvas/media_files.py`). SVG and PSD
  publish only a PNG; a PDF keeps its original and adds one PNG per page (at most 200 pages of 40
  megapixels). A job that fails three claims is marked failed.
- Upload via URL (`POST /api/canvas-boards/<id>/import-url`) fetches a public HTTPS address with the SSRF
  guarded fetcher. An HTML page becomes a link card with its title, description, preview image and
  favicon (stored as PNG, cached for an hour); a file goes through the same path as an upload, with an
  imported video capped at 150 MiB.
- Saved files (`GET /api/canvas-boards/<id>/media`) lists ready files from every board the person can
  read, newest first, 100 per page.

## Embeds

`src/lib/canvas/embeds.js` turns a pasted link or iframe code into the provider's own embed address
(YouTube, Vimeo, Loom, Dailymotion, Spotify, SoundCloud, Figma, Google Drive). Only the frame's `src` is
kept. `backend/apps/canvas/embeds.py` holds the same address rules, and the board serializer saves an
embed only when its address passes them. The frame is sandboxed.

## Scope

This slice covers miro-checklist.md lines 253-272 except the lines below.

- **GIFs** (search and place GIFs through Giphy or Tenor): declined by the captain on 2026-11-01.
  Animated GIFs still upload as images.
- **Images and icons library**, Unsplash stock photo search: declined by the captain on 2026-11-01. The
  bundled recolorable icon set is built.
- **Automatic closed captions**: declined by the captain on 2026-11-01 in favour of the on-demand
  "Generate captions" button described below.

## On-demand video captions

An editor selects a board video and chooses "Generate captions". The panel shows the model and the cost step first
(transcription has no metered price in Veevee, so none is invented); nothing runs until "Start". The backend
(`apps/canvas/captions.py`, `caption_views.py`) extracts the video's audio, transcribes it through the existing
audio paid-guard path and stores WebVTT in `canvas_board_captions`, outside the board JSON. The caption row is
committed together with its transcription job, so a second click or a second editor never submits another paid job.
`GET /api/canvas-boards/<id>/captions?src=` quotes, `POST` generates (edit access), and `GET .../captions/vtt?src=`
serves `text/vtt` to anyone who can view the board. The video node fetches that text through the API and attaches it
as a blob `<track>`, so the video never sets `crossOrigin` and CDN redirects keep working. Viewers and commenters can
toggle CC but cannot generate.

`POST` waits up to 110 s and answers 202 with `pending: true` if the job is still running then. The quote finishes
that run once the job ends: it stores the VTT on success. While the audio job is queued or running the run stays
pending, however long admission takes, and Start stays hidden. A run is marked failed only when its job failed or was
cancelled, or when its submission stayed uncertain for 32 minutes (the audio job's 120 s provider timeout plus a wide
margin); the quote reports the reason as `failure`, the panel shows "Captions failed, try again." and offers Start
again, and the next run takes over the row. Nothing sweeps or cancels audio jobs; the check happens when the row is
read. The panel checks again every few seconds while the run is pending. Only media that `/api/media/` would serve
(the shared read policy, so no unfinished uploads or exports) is captioned.

The gateway lets the `POST` through only with the paid initial routes on, and waits 125 s for it, the same as
`/api/audio/transcribe` (`deploy/gateway.py` `BOARD_TRANSCRIPTIONS`, which also covers the Talktrack transcript).

Known gap: nothing refunds, reconciles or clears an uncertain audio submission. If Gemini did run an uncertain job, a
retry after the grace period bills a second transcription. Audio admission (`audio_capacity_available`) also counts
every `SUBMISSION_UNCERTAIN` row against its limits for good: one per user, two in total. So if the editor whose
submission was uncertain retries, the new job never leaves the queue. The run stays pending, and Start stays hidden
for every editor on that board, until an operator resolves the uncertain audio row. Two uncertain rows anywhere stop
all audio admission the same way.
