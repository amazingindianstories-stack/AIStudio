#!/usr/bin/env bash
# Start the local depth-map worker. This is the "leave a terminal process
# open" side of the feature — closing this terminal (or the machine sleeping)
# is exactly what should flip the nav bar's status pill to offline; nothing
# else needs to be told.
cd "$(dirname "$0")" || exit 1

if [ ! -f ".env" ]; then
  echo "No .env found — copy .env.example to .env and fill in DEPTH_WORKER_TOKEN" \
       "and DEPTH_ASSETS_ROOT first." >&2
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "No .venv found. Setting up (Python 3.11 + deps)…"
  uv venv --python 3.11
  uv pip install -r requirements.txt
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

echo "Starting depth-map worker (device auto-detected, Ctrl+C to stop)…"
# Restart loop: the watchdog thread in worker.py can deliberately hard-exit
# (os._exit) if RSS blows well past the configured cap — see RAM_LIMIT_MB's
# comment there — and this is what turns that into "recovers on its own"
# instead of "the pill silently stays offline until someone notices and
# re-runs this script by hand." A crash or a transient network outage during
# startup is handled the same way.
while true; do
  ./.venv/bin/python worker.py
  echo "Worker exited (code $?) — restarting in 3s… (Ctrl+C to stop for real)"
  sleep 3
done
