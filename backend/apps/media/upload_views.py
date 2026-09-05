import uuid

from rest_framework.decorators import api_view
from rest_framework.response import Response

from .storage import get_signed_upload_url


@api_view(["POST"])
def presign_upload(request):
    body = request.data if isinstance(request.data, dict) else {}
    if body.get("purpose") != "depth-input":
        return Response({"error": "Unknown upload purpose (expected one of: depth-input)."}, status=400)
    content_type = body.get("contentType") if isinstance(body.get("contentType"), str) else ""
    if not content_type.startswith("video/"):
        return Response({"error": f'depth-input does not accept content type "{content_type}".'}, status=400)
    key = f"uploads/depth-input/{request.user.id}-{uuid.uuid4()}"
    try:
        return Response({"key": key, "uploadUrl": get_signed_upload_url(key, content_type)})
    except Exception as exc:
        return Response({"error": str(exc) or "Failed to create an upload URL."}, status=500)
