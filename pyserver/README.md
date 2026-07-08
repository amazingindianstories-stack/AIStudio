# Lumina — Local InstantID service

Runs **SDXL (RealVisXL V4.0) + InstantID** on your Mac's GPU (Apple MPS) to
generate images that **lock the face** from an uploaded reference. No API key,
no cloud, no real-person filter — fully local and private.

The Next.js app calls this service when you pick **"Local · InstantID"** in the
image model dropdown.

## First-time setup

```bash
cd pyserver
uv venv --python 3.11
uv pip install -r requirements.txt
./.venv/bin/python setup_models.py     # InstantID code + antelopev2 face model
```

## Run

```bash
./start.sh
# or:  PYTORCH_ENABLE_MPS_FALLBACK=1 ./.venv/bin/python -m uvicorn app:app --port 8765
```

- First request triggers a one-time ~9GB weight download (RealVisXL + InstantID).
- Warm it up ahead of time: `curl http://127.0.0.1:8765/warmup`
- Health: `curl http://127.0.0.1:8765/health`

## Endpoint

`POST /generate`
```json
{
  "prompt": "cinematic portrait of the person as a CEO, photorealistic",
  "image": "data:image/jpeg;base64,…",   // reference face
  "aspect_ratio": "1:1",
  "identitynet_scale": 0.8,   // face structure strength (ControlNet)
  "adapter_scale": 0.8,       // face identity strength (IP-Adapter)
  "steps": 30,
  "guidance": 5.0
}
```
Returns `{ "image": "data:image/png;base64,…" }`.

## Tuning identity vs. creativity

- **Stronger face match:** raise `adapter_scale` (0.8 → 1.0) and `identitynet_scale` (0.8 → 1.0).
- **More prompt freedom / less rigid pose:** lower `identitynet_scale` (0.8 → 0.5).
- ~30 steps is a good speed/quality balance (~60–90s on M1 Ultra). Raise to 40–50 for max detail.

## Config (env)

- `SDXL_MODEL` — base checkpoint (default `SG161222/RealVisXL_V4.0`).
- `LOCAL_AI_URL` (set in the Next.js app's `.env.local`) — defaults to `http://127.0.0.1:8765`.
