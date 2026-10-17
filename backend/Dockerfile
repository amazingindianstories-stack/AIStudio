FROM python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Image decoding on many threads fragments glibc's per-thread arenas; two keep RSS flat (measured 1.4 GB -> 0.4 GB).
ENV MALLOC_ARENA_MAX=2
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libvips42 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/constraints-qualified.txt ./
RUN pip install --no-cache-dir -c constraints-qualified.txt -r requirements.txt
COPY backend/ ./
# Railway sets the start command per service: python -m deploy.entrypoint {api|generation|export|scheduler}
CMD ["python", "-m", "deploy.entrypoint", "api"]
