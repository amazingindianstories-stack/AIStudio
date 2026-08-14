# veevee — local depth-map worker

Runs [Video-Depth-Anything](https://github.com/DepthAnything/Video-Depth-Anything)
(optionally with YOLOv8-seg character tracking composited on top) on your own
machine's GPU, and dials **out** to veevee to pick up "Depth Map" jobs
submitted from the web app. No inbound ports, no tunnel, no static IP —
this process only ever makes outbound HTTPS requests, the same way a browser
tab does, so it works behind an ordinary home router.

The nav bar's Depth destination shows a small dot next to it: green while
this process is running and has heartbeated recently, red otherwise. Closing
this terminal (or the machine sleeping) is what turns it red — nothing else
needs to be told.

## How it fits together

```
 veevee (Vercel/Railway)                  this machine
 ┌─────────────────────────┐              ┌───────────────────────────┐
 │ generations table        │  poll every  │ worker.py                 │
 │  kind='depth', queued ───┼─────3s───────┼─▶ claims job, downloads   │
 │                          │              │   input video, runs VDA   │
 │ depth_workers table      │◀── every 15s ┼── heartbeat (RAM, device) │
 │  (drives the status pill)│              │                            │
 │                          │◀─────────────┼── progress updates        │
 │                          │◀─────────────┼── uploads result, marks   │
 │                          │              │    the job succeeded      │
 └─────────────────────────┘              └───────────────────────────┘
```

Nothing here is a web server — there's no port to open, no `curl` health
check to hit locally. The only observability is the nav bar pill and this
terminal's own log lines.

## First-time setup

1. Get `Video-Depth-Anything` checked out and its checkpoints downloaded
   (its own README covers this — you likely already have this at
   `neural-networks-workflow/video-depth-maps/Video-Depth-Anything` with
   `checkpoints/` populated, and `yolov8n-seg.pt` as a sibling of that repo
   for the character-tracking option).
2. `cp .env.example .env` and fill in:
   - `VEEVEE_API_URL` — wherever the app is actually deployed.
   - `DEPTH_WORKER_TOKEN` — must be the exact value set on the server's
     `DEPTH_WORKER_TOKEN` env var (Vercel/Railway). Generate one with
     `python3 -c "import secrets; print(secrets.token_hex(32))"` if the
     server side hasn't set one yet.
   - `DEPTH_ASSETS_ROOT` — path to the `video-depth-maps` folder described
     above.
3. `./start.sh` — first run creates a `.venv` (via `uv`) and installs
   dependencies; every run after that starts immediately.

## Run

```bash
./start.sh
```

Leave this terminal open. `start.sh` wraps the worker in a restart loop, so
a crash, a network blip, or the RAM watchdog's own safety exit (see below)
all recover on their own rather than silently leaving the pill red until
someone notices.

## Encoder choice (quality vs. speed)

Chosen per-job from the composer, not here:

| Encoder | Params | Notes |
|---|---|---|
| `vits` | 28M | Fastest, lowest detail |
| `vitb` | 113M | Default — good detail at a reasonable speed |
| `vitl` | 382M | Most detail, but sized for A100-class GPUs per Video-Depth-Anything's own benchmark table — expect it to be slow on a single Mac |

## Character tracking

The "Track characters" checkbox in the composer runs the same approach
already proven in `video-depth-maps/scripts/color_code_depth.py`: YOLOv8-seg
tracks people frame-to-frame (`classes=[0]`, i.e. persons only) and each
tracked person is tinted a distinct color on top of the depth map, output
side-by-side with the original frame. Off, the output is a plain grayscale
depth video. Tracking roughly doubles processing time per job (two models
run per frame instead of one).

## RAM cap

`DEPTH_RAM_LIMIT_MB` (default 32000 = 32GB) is a **soft, best-effort** cap,
not a hard OS-enforced ceiling — true hard enforcement needs cgroups, which
macOS doesn't have. Two mechanisms back it, both in `worker.py`:

- A background thread samples this process's actual memory use every 5s.
  Cross the cap and the worker stops **claiming new jobs** (a job already in
  progress is allowed to finish rather than being killed mid-inference,
  which could corrupt output) until usage drops back down.
- If usage ever balloons to 1.3× the cap — something has gone wrong, not
  just "a large video" — the process exits outright. `start.sh`'s restart
  loop brings it back a few seconds later.

Raise `DEPTH_RAM_LIMIT_MB` in `.env` if 32GB is too conservative for this
machine; the confirmed range for a 64GB Mac is up to ~48GB, leaving the rest
for the OS and everything else running on it.

## Troubleshooting

- **Pill stays red / "Worker offline" in the composer**: this terminal isn't
  running, `DEPTH_WORKER_TOKEN` doesn't match the server's, or
  `VEEVEE_API_URL` is wrong. Check this terminal's own log lines first — a
  failed heartbeat prints a message every 15s rather than failing silently.
- **Job stays queued forever**: the worker only *polls* for work every 3s —
  it isn't pushed a job the instant one is submitted, so a few seconds of
  lag before it picks something up is normal.
- **`Video-Depth-Anything checkout not found`**: `DEPTH_ASSETS_ROOT` in
  `.env` doesn't point at the right folder, or the `Video-Depth-Anything/`
  subfolder isn't there.

## Not yet done

- Per-frame progress is coarse (a handful of named milestones — downloading,
  loading, estimating depth, compositing, encoding, uploading), not true
  frame-by-frame percent. `infer_video_depth` has no progress callback in
  Video-Depth-Anything's stock API; wiring real per-frame granularity means
  patching the vendored inference loop, not attempted here.
- This has not been run end to end against a real veevee deployment or a
  real GPU — see the caveat at the top of `worker.py`. Verify the first real
  job carefully.
