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
- **Automatic closed captions**: deferred by the captain on 2026-11-01 to a separate on-demand
  "Generate captions" task, which adds the video `captions` field, its WebVTT track and the generator
  together.
