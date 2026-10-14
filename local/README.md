# Local Veevee

The whole application on this Mac: PostgreSQL (restored Green copy), the API with the production
entrypoint and gateway, generation/export workers, the scheduler, fake providers, the Next.js
frontend and (optionally) the real depth worker. Nothing here touches production; providers are
fake (no keys, no cost) and the backend services sit on an internal Docker network.

```sh
local/veevee.sh up          # build image, restore the Green copy (first run), start services
local/veevee.sh user        # local admin login (prints email + password)
local/veevee.sh frontend    # http://localhost:3000
local/veevee.sh depth       # optional: real Video-Depth-Anything worker (needs its venv + checkpoints)
python3 local/smoke.py      # end-to-end check through the frontend
node local/ui_check.mjs <dir>   # headless screenshots: Portrait Gallery, Admin Limits
local/veevee.sh status | logs [svc] | restart [svc] | migrate | down | reset
```

- `local/.env` holds generated local-only secrets (gitignored).
- Backend code is mounted read-only; `restart <svc>` picks up changes.
- Fake provider state (BytePlus asset pool, Seedance tasks) is in memory: restarting
  `fake-providers` empties it, which also exercises remote-drift recovery.
- `http://127.0.0.1:18099/control` adjusts the fake (e.g. pool capacity) for manual tests.
