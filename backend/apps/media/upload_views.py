import re
import uuid

from rest_framework.decorators import api_view
from rest_framework.response import Response

from .audio import AUDIO_MIME
from .storage import get_signed_upload_url

PURPOSES = {
    "depth-input": re.compile(r"video/.+"),
    "image-reference": re.compile(r"image/(jpeg|png|webp|tiff|gif|heic|heif)"),
    "audio-reference": AUDIO_MIME,
}

@api_view(["POST"])
def presign_upload(request):
    body = request.data if isinstance(request.data, dict) else {}
    purpose = body.get("purpose")
    if not isinstance(purpose, str) or purpose not in PURPOSES:
        return Response({"error": "Unknown upload purpose."}, status=400)
    content_type = body.get("contentType") if isinstance(body.get("contentType"), str) else ""
    if not PURPOSES[purpose].fullmatch(content_type):
        return Response({"error": f'{purpose} does not accept content type "{content_type}".'}, status=400)
    key = f"uploads/{purpose}/{request.user.id}-{uuid.uuid4()}"
    try:
        return Response({"key": key, "uploadUrl": get_signed_upload_url(key, content_type)})
    except Exception:
        return Response({"error": "Failed to create an upload URL."}, status=500)
