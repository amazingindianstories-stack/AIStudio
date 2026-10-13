FROM python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libvips42 && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt backend/constraints-qualified.txt ./
RUN pip install --no-cache-dir -c constraints-qualified.txt -r requirements.txt
COPY backend/ ./
CMD ["sh", "-c", "exec gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000} --workers 2 --worker-class gthread --threads 4 --timeout 30 --error-logfile -"]
