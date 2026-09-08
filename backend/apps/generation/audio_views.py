"""Timestamped Gemini transcription, saved in the shared project's history."""
import base64
import os
import time
import uuid

import requests
from rest_framework.decorators import api_view
from rest_framework.response import Response

from apps.media.audio import AUDIO_MIME, MAX_AUDIO_BYTES
from apps.media.storage import read_as_base64
from apps.projects.models import Project
from .queue_service import upsert_item

PROMPT = "Transcribe this audio for use as a video-generation prompt. Return only a clean, timestamped transcript in this exact format, one line per segment: [MM:SS.mmm - MM:SS.mmm] Speaker or sound: words or description. Include meaningful music, ambience, sound effects, pauses, and speaker changes. Do not add a title, markdown fence, commentary, or invented content."

@api_view(["POST"])
def transcribe(request):
    body = request.data if isinstance(request.data, dict) else {}
    ref = body.get("audioRef")
    # Only read an authenticated user's signed-upload namespace. Never fetch
    # arbitrary URLs or protected storage keys supplied in a transcription body.
    prefix = f"/api/media/uploads/audio-reference/{request.user.id}-"
    if not isinstance(ref, str) or not ref.startswith(prefix) or not ref[len(prefix):] or any(c in ref[len(prefix):] for c in "/?%#"):
        return Response({"error": "Use an uploaded audio reference."}, status=400)
    project_id = body.get("projectId")
    try:
        project_id = str(uuid.UUID(project_id)) if project_id else None
    except (ValueError, TypeError, AttributeError):
        return Response({"error": "Invalid project."}, status=400)
    if project_id and not Project.objects.filter(id=project_id).exists():
        return Response({"error": "Project not found."}, status=404)
    try:
        mime, data = read_as_base64(ref)
        if not AUDIO_MIME.fullmatch(mime):
            return Response({"error": "Use MP3, WAV, M4A, OGG, AAC, FLAC or WebM audio."}, status=400)
        if len(base64.b64decode(data, validate=True)) > MAX_AUDIO_BYTES:
            return Response({"error": "Audio files must be 15 MB or smaller."}, status=413)
        key = os.environ.get("GOOGLE_API_KEY")
        if not key:
            return Response({"error": "Audio transcription is not configured."}, status=503)
        model = os.environ.get("AUDIO_TRANSCRIPTION_MODEL") or "gemini-2.5-flash"
        response = requests.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key},
            json={"contents": [{"role": "user", "parts": [{"inlineData": {"mimeType": mime.lower(), "data": data}}, {"text": PROMPT}]}], "generationConfig": {"temperature": 0.1}},
            timeout=(10, 100),
        )
        if not response.ok:
            return Response({"error": f"Gemini transcription failed ({response.status_code})."}, status=502)
        result = response.json()
        parts = ((result.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        transcript = "\n".join(p.get("text", "") for p in parts).strip()
        if not transcript:
            return Response({"error": "Gemini returned an empty transcription."}, status=502)
        now = int(time.time() * 1000)
        item = {"id": str(uuid.uuid4()), "kind": "audio", "status": "succeeded", "prompt": transcript, "model": f"Gemini ({model})", "aspectRatio": "audio", "referenceAudios": [ref], "projectId": project_id, "userId": str(request.user.id), "costCents": 0, "costBasis": "estimated", "createdAt": now, "updatedAt": now, "productionMetadata": {"type": "audio-transcription", "originalName": str(body.get("name") or "audio")[:200], "transcript": transcript, "sourceAudio": ref}}
        upsert_item(item)
        return Response({**item, "transcript": transcript})
    except requests.Timeout:
        return Response({"error": "Transcription timed out. The request was not retried."}, status=504)
    except Exception:
        return Response({"error": "Transcription failed."}, status=500)
