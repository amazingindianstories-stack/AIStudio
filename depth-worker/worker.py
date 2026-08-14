"""
Local depth-map worker — dials OUT to veevee (see CLAUDE.md's "Depth-map
worker" section), claims queued kind='depth' generations, runs
Video-Depth-Anything (optionally with YOLOv8-seg character tracking
composited on top, matching video-depth-maps/scripts/color_code_depth.py),
and uploads the result back.

This process never accepts inbound connections and opens no ports — it only
ever makes outbound HTTPS calls to VEEVEE_API_URL, which is what lets it run
behind a home router/NAT with zero port-forwarding or tunnel setup. See
depth-worker/README.md for setup.

Not live-tested against a real veevee deployment or a real GPU (this was
written in a sandbox with no network egress to a real API and no CUDA/MPS
device) — same caveat this migration's own Higgsfield MCP port and
generation-core phase carry (see CLAUDE.md's backend/ section): structural
fidelity comes from reading Video-Depth-Anything's run.py and
color_code_depth.py's exact call shapes, not from having run this end to
end. Re-verify the first real run against a real job before trusting it
unattended.
"""

import argparse
import io
import json
import os
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import psutil
import requests

# ── config ──────────────────────────────────────────────────────────────

API_URL = os.environ.get("VEEVEE_API_URL", "http://127.0.0.1:3000").rstrip("/")
WORKER_TOKEN = os.environ.get("DEPTH_WORKER_TOKEN", "")
WORKER_LABEL = os.environ.get("DEPTH_WORKER_LABEL", "")
# The neural-networks-workflow/video-depth-maps checkout — holds both the
# Video-Depth-Anything/ repo and yolov8n-seg.pt as siblings. Kept as a single
# root (rather than two separate env vars) because that's how the assets
# already sit on disk; see README.md.
ASSETS_ROOT = Path(os.environ.get("DEPTH_ASSETS_ROOT", "")).expanduser()
VDA_REPO = ASSETS_ROOT / "Video-Depth-Anything"
YOLO_WEIGHTS = ASSETS_ROOT / "yolov8n-seg.pt"

# Soft cap, checked by the watchdog thread below — NOT a hard OS-enforced
# ceiling. True hard RSS enforcement needs cgroups, which macOS doesn't have;
# resource.setrlimit(RLIMIT_AS) is attempted too (see _try_hard_rlimit) but is
# unreliable on macOS for the same reason and is only ever a best-effort
# extra layer, never the thing actually relied on here.
RAM_LIMIT_MB = int(os.environ.get("DEPTH_RAM_LIMIT_MB", "32000"))
# Hard backstop: if RSS gets this far over the soft cap, exit the process
# outright rather than let an unbounded allocation take the whole machine
# down. start.sh's restart loop is what brings it back — see that file.
HARD_EXIT_RATIO = 1.3

HEARTBEAT_INTERVAL_S = 15
CLAIM_POLL_INTERVAL_S = 3
WATCHDOG_INTERVAL_S = 5

WORKER_ID_FILE = Path(__file__).parent / ".worker-id"


def _worker_id() -> str:
    """Stable across restarts — see schema.js's depth_workers docstring for
    why this (not the DB row's own uuid) is the upsert key: a restarted
    worker should update its existing row, not spawn a new "worker" that
    looks like a second machine."""
    if WORKER_ID_FILE.exists():
        return WORKER_ID_FILE.read_text().strip()
    wid = f"worker-{uuid.uuid4().hex[:12]}"
    WORKER_ID_FILE.write_text(wid)
    return wid


WORKER_ID = _worker_id()


def _device() -> str:
    """Mirrors Video-Depth-Anything's own run.py exactly."""
    import torch

    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _try_hard_rlimit(limit_mb: int) -> None:
    """Best-effort. Not the real enforcement mechanism — see RAM_LIMIT_MB's
    comment — but cheap to attempt and occasionally helps on Linux."""
    try:
        import resource

        limit_bytes = limit_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit_bytes, limit_bytes))
    except Exception as e:  # noqa: BLE001 — advisory only
        print(f"[worker] soft rlimit attempt failed (expected on macOS, non-fatal): {e}")


# ── HTTP helpers ────────────────────────────────────────────────────────


def _headers():
    return {"Authorization": f"Bearer {WORKER_TOKEN}", "Content-Type": "application/json"}


def _post(path: str, body: dict, timeout: int = 30) -> dict:
    res = requests.post(f"{API_URL}{path}", headers=_headers(), data=json.dumps(body), timeout=timeout)
    res.raise_for_status()
    return res.json()


# ── RAM watchdog ────────────────────────────────────────────────────────

_over_budget = threading.Event()


def _watchdog_loop():
    """Blocks new job admission (via _over_budget) once RSS crosses the soft
    cap, and hard-exits if it crosses HARD_EXIT_RATIO of it. Runs for the
    life of the process, independent of whether a job is in flight —
    everything Python (torch, opencv, ultralytics) allocates counts."""
    proc = psutil.Process(os.getpid())
    while True:
        rss_mb = proc.memory_info().rss / (1024 * 1024)
        if rss_mb > RAM_LIMIT_MB * HARD_EXIT_RATIO:
            print(
                f"[worker] RSS {rss_mb:.0f}MB is {HARD_EXIT_RATIO}x the {RAM_LIMIT_MB}MB cap — "
                "exiting now. Restart this under a supervisor loop (see start.sh) so it recovers."
            )
            os._exit(1)  # noqa: SLF001 — deliberate hard exit, not a normal return path
        _over_budget.set() if rss_mb > RAM_LIMIT_MB else _over_budget.clear()
        time.sleep(WATCHDOG_INTERVAL_S)


# ── heartbeat ───────────────────────────────────────────────────────────

_current_job_id = None
_worker_status = "idle"


def _heartbeat_loop():
    proc = psutil.Process(os.getpid())
    while True:
        try:
            _post(
                "/api/worker/depth/heartbeat",
                {
                    "workerId": WORKER_ID,
                    "label": WORKER_LABEL or None,
                    "device": _device_cached[0],
                    "status": _worker_status,
                    "currentJobId": _current_job_id,
                    "ramLimitMb": RAM_LIMIT_MB,
                    "ramUsedMb": round(proc.memory_info().rss / (1024 * 1024)),
                },
                timeout=10,
            )
        except Exception as e:  # noqa: BLE001 — a missed heartbeat just means the pill goes stale briefly
            print(f"[worker] heartbeat failed (will retry): {e}")
        time.sleep(HEARTBEAT_INTERVAL_S)


_device_cached = [None]


# ── model loading (lazy, cached per encoder) ───────────────────────────

_models = {}


def _load_model(encoder: str):
    """Cached per encoder so repeated jobs at the same quality tier don't
    reload weights, but three different encoders in a row do cost three
    loads — a full multi-encoder warm cache would use more RAM than most
    single-machine setups want sitting idle between jobs."""
    if encoder in _models:
        return _models[encoder]

    sys.path.insert(0, str(VDA_REPO))
    import torch
    from video_depth_anything.video_depth import VideoDepthAnything  # noqa: E402

    configs = {
        "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
        "vitb": {"encoder": "vitb", "features": 128, "out_channels": [96, 192, 384, 768]},
        "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
    }
    model = VideoDepthAnything(**configs[encoder])
    ckpt = VDA_REPO / "checkpoints" / f"video_depth_anything_{encoder}.pth"
    model.load_state_dict(torch.load(str(ckpt), map_location="cpu"), strict=True)
    device = _device_cached[0]
    model = model.to(device).eval()
    _models[encoder] = model
    return model


# ── one job ─────────────────────────────────────────────────────────────


def _report_progress(job_id: str, percent: int, message: str):
    try:
        _post("/api/worker/depth/progress", {"jobId": job_id, "percent": percent, "message": message}, timeout=10)
    except Exception as e:  # noqa: BLE001 — a dropped progress ping isn't worth failing the job over
        print(f"[worker] progress report failed (continuing): {e}")


def _complete_ok(job_id: str, key: str, aspect_ratio: str | None):
    _post("/api/worker/depth/complete", {"jobId": job_id, "ok": True, "key": key, "aspectRatio": aspect_ratio})


def _complete_failed(job_id: str, error: str):
    try:
        _post("/api/worker/depth/complete", {"jobId": job_id, "ok": False, "error": error[:2000]})
    except Exception as e:  # noqa: BLE001 — best-effort; the row is left "running" and reap logic elsewhere is out of scope for v1
        print(f"[worker] could not report failure for {job_id}: {e}")


def _nearest_aspect_ratio(w: int, h: int) -> str:
    """Same reasoning as providers/kling.js's nearestKlingAspectRatio — the
    stored placeholder ("16:9") from the enqueue route would mislabel the
    library card, so the worker measures the real output and reports it."""
    candidates = [
        ("1:1", 1), ("4:3", 4 / 3), ("3:4", 3 / 4), ("16:9", 16 / 9),
        ("9:16", 9 / 16), ("21:9", 21 / 9), ("3:2", 3 / 2), ("2:3", 2 / 3),
    ]
    import math

    ratio = w / h
    best = min(candidates, key=lambda c: abs(math.log(ratio) - math.log(c[1])))
    return best[0]


def _run_depth(input_path: str, output_path: str, encoder: str, track_characters: bool, job_id: str):
    sys.path.insert(0, str(VDA_REPO))
    from utils.dc_utils import read_video_frames, save_video  # noqa: E402

    _report_progress(job_id, 5, "Loading model")
    model = _load_model(encoder)
    device = _device_cached[0]

    _report_progress(job_id, 15, "Reading input video")
    frames, fps = read_video_frames(input_path, -1, -1, 1280)

    _report_progress(job_id, 30, "Running depth estimation")
    # infer_video_depth has no per-frame progress callback in the stock API
    # (confirmed reading run.py) — the 30%/70% milestones below bracket this
    # call rather than tracking real per-frame progress through it. Patching
    # the vendored inference loop for true granularity is a reasonable
    # follow-up, not attempted here.
    # fp16 (fp32=False) is VDA's own default and the fast path on CUDA, but it
    # silently produces all-NaN depths on MPS — confirmed 2026-08-14 against
    # this exact checkpoint/device by comparing fp32=False vs fp32=True output
    # directly (NaN min/max/mean vs real values). The NaN doesn't crash
    # anything downstream: dc_utils.save_video's normalization casts it to a
    # uniformly-zero uint8 array, which the inferno colormap renders as a
    # video that looks plausible at a glance (not a black screen, just a
    # uniformly near-black one) and uploads/completes successfully — so this
    # produced a "succeeded" job with a genuinely broken depth map end to end
    # before being caught. CPU gets the same treatment since it has no
    # real fp16 speed benefit to trade away.
    fp32 = device != "cuda"
    depths, out_fps = model.infer_video_depth(frames, fps, input_size=518, device=device, fp32=fp32)

    if track_characters:
        _report_progress(job_id, 70, "Compositing character tracking")
        _write_tracked_composite(frames, depths, output_path, out_fps)
    else:
        _report_progress(job_id, 85, "Encoding output video")
        save_video(depths, output_path, fps=out_fps, is_depths=True, grayscale=False)

    h, w = depths[0].shape[-2], depths[0].shape[-1]
    if track_characters:
        w = w * 2  # side-by-side composite is double width — see _write_tracked_composite
    return _nearest_aspect_ratio(w, h)


def _get_color(track_id: int):
    import numpy as np

    colors = [
        [255, 105, 180], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0],
    ]
    return np.array(colors[(track_id - 1) % len(colors)])


def _write_tracked_composite(frames, depths, output_path: str, fps: float):
    """Direct port of video-depth-maps/scripts/color_code_depth.py's
    compositing loop — same output shape (original | color-coded depth,
    side by side), same person-only tracking (classes=[0]), same palette.
    The only difference from that script is depths/frames are already
    computed by the caller instead of being generated inline."""
    import cv2
    import imageio
    import numpy as np
    from ultralytics import YOLO

    yolo = YOLO(str(YOLO_WEIGHTS))
    writer = imageio.get_writer(
        output_path, fps=fps, macro_block_size=1, codec="libx264", pixelformat="yuv420p", ffmpeg_params=["-crf", "18"]
    )
    d_min, d_max = depths.min(), depths.max()

    try:
        for i in range(len(frames)):
            frame = frames[i]
            depth = depths[i]
            depth_norm = ((depth - d_min) / (d_max - d_min) * 255).astype(np.uint8)
            base_depth_rgb = np.stack((depth_norm,) * 3, axis=-1)

            results = yolo.track(frame, persist=True, classes=[0], verbose=False)
            composite = base_depth_rgb.copy()

            if results[0].boxes is not None and results[0].masks is not None:
                boxes = results[0].boxes
                masks = results[0].masks.data.cpu().numpy()
                for j in range(len(boxes)):
                    track_id = int(boxes.id[j].item()) if boxes.id is not None else j + 1
                    mask = cv2.resize(masks[j], (frame.shape[1], frame.shape[0]))
                    color = _get_color(track_id)
                    tinted = (depth_norm[..., None] / 255.0 * color).astype(np.uint8)
                    alpha = mask[..., None]
                    composite = np.where(alpha > 0.5, tinted, composite)

            h, w = composite.shape[:2]
            orig_resized = cv2.resize(frame, (w, h))
            writer.append_data(np.hstack((orig_resized, composite)))
    finally:
        writer.close()


def _process_job(job: dict):
    global _current_job_id, _worker_status
    job_id = job["id"]
    _current_job_id = job_id
    _worker_status = "busy"

    with tempfile.TemporaryDirectory(prefix="depth-job-") as tmp:
        input_path = os.path.join(tmp, "input.mp4")
        output_path = os.path.join(tmp, "output.mp4")
        try:
            _report_progress(job_id, 0, "Downloading input video")
            with requests.get(job["inputVideoUrl"], stream=True, timeout=120) as r:
                r.raise_for_status()
                with open(input_path, "wb") as f:
                    for chunk in r.iter_content(chunk_size=1 << 20):
                        f.write(chunk)

            aspect_ratio = _run_depth(
                input_path, output_path, job.get("encoder") or "vitb", job.get("trackCharacters") is True, job_id
            )

            _report_progress(job_id, 92, "Requesting an upload slot")
            upload = _post("/api/worker/depth/upload-url", {"jobId": job_id})

            _report_progress(job_id, 95, "Uploading result")
            with open(output_path, "rb") as f:
                put = requests.put(upload["uploadUrl"], data=f, headers={"Content-Type": "video/mp4"}, timeout=300)
                put.raise_for_status()

            _complete_ok(job_id, upload["key"], aspect_ratio)
            print(f"[worker] job {job_id} done")
        except Exception as e:  # noqa: BLE001 — any failure here must still report back, not just crash the loop
            print(f"[worker] job {job_id} failed: {e}")
            _complete_failed(job_id, str(e))
        finally:
            _current_job_id = None
            _worker_status = "idle"


# ── main loop ───────────────────────────────────────────────────────────


def _claim_loop():
    while True:
        if _over_budget.is_set():
            print(f"[worker] over the {RAM_LIMIT_MB}MB soft cap — not claiming new work until it drops")
            time.sleep(WATCHDOG_INTERVAL_S)
            continue
        try:
            resp = _post("/api/worker/depth/claim", {"workerId": WORKER_ID}, timeout=15)
            job = resp.get("job")
        except Exception as e:  # noqa: BLE001 — transient — just retry
            print(f"[worker] claim request failed (will retry): {e}")
            time.sleep(CLAIM_POLL_INTERVAL_S)
            continue
        if not job:
            time.sleep(CLAIM_POLL_INTERVAL_S)
            continue
        _process_job(job)


def main():
    parser = argparse.ArgumentParser(description="veevee depth-map local worker")
    parser.parse_args()

    if not WORKER_TOKEN:
        sys.exit("DEPTH_WORKER_TOKEN is not set — see depth-worker/README.md.")
    if not VDA_REPO.exists():
        sys.exit(f"Video-Depth-Anything checkout not found at {VDA_REPO} — check DEPTH_ASSETS_ROOT.")

    _device_cached[0] = _device()
    print(f"[worker] id={WORKER_ID} device={_device_cached[0]} ram_cap={RAM_LIMIT_MB}MB api={API_URL}")

    _try_hard_rlimit(RAM_LIMIT_MB)
    threading.Thread(target=_watchdog_loop, daemon=True).start()
    threading.Thread(target=_heartbeat_loop, daemon=True).start()
    _claim_loop()


if __name__ == "__main__":
    main()
