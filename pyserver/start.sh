#!/usr/bin/env bash
# Start the local InstantID image service (SDXL + InstantID on Apple MPS).
# First run downloads the model weights (~9GB) and loads them.
cd "$(dirname "$0")" || exit 1

if [ ! -d ".venv" ]; then
  echo "No .venv found. Setting up (Python 3.11 + deps)…"
  uv venv --python 3.11
  uv pip install -r requirements.txt
  ./.venv/bin/python setup_models.py
fi

echo "Starting InstantID service on http://127.0.0.1:8765 …"
PYTORCH_ENABLE_MPS_FALLBACK=1 exec ./.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8765
