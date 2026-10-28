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
node local/errors_check.mjs <dir>   # headless Chrome screenshots: admin Errors tab (desktop, phone), copy block
local/veevee.sh status | logs [svc] | restart [svc] | migrate | down | reset
```

- `local/.env` holds generated local-only secrets (gitignored).
- Backend code is mounted read-only; `restart <svc>` picks up changes.
- Fake provider state (BytePlus asset pool, Seedance tasks) is in memory: restarting
  `fake-providers` empties it, which also exercises remote-drift recovery.
- `http://127.0.0.1:18099/control` adjusts the fake (e.g. pool capacity) for manual tests.
- The MCP service is opt-in (compose profile `mcp`, no provider keys):
  `docker compose -f local/compose.yaml --env-file local/.env --profile mcp up -d mcp`, then
  `MCP_API_ORIGIN=http://127.0.0.1:18083 local/veevee.sh frontend` serves it at `http://localhost:3000/mcp`.
  Without the whole stack, `scripts/dev/mcp-harness.py --serve` (through `scripts/dev/test-db.sh`)
  runs it on a disposable database with the same fake providers (a fake provider server it starts itself).
