"""Port of src/app/api/{generate/depth,generate/depth/status,
worker/depth/*}/route.js. Kept separate from generation_views.py (that
file's own docstring flags it as the highest-risk file in the migration;
this is an unrelated subsystem and mixing them would blur that focus).

Two auth shapes on this one file, matching the TS side exactly:
 - generate_depth / depth_status: normal session auth (default
   DEFAULT_AUTHENTICATION_CLASSES / IsAuthenticated — just @api_view, no
   override), same as generate_image.
 - worker_*: @permission_classes([]) + a manual verify_worker_token check.
   The caller is a Python process with no session, not a browser — see
   depth_worker_auth.py.
"""

import time
import uuid

from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.common.activity import log_activity
from apps.media import storage

from . import depth_jobs_service
from .config import DEPTH_ENCODERS, DEPTH_MODEL_NAME
from .depth_worker_auth import verify_worker_token
from .generations_service import get_item
from .queue_service import upsert_item


def _unauthorized():
    return Response({"error": "Unauthorized."}, status=401)


@api_view(["POST"])
def generate_depth(request):
    body = request.data or {}
    input_video_key = (body.get("inputVideoKey") or "").strip()
    encoder = body.get("encoder") if body.get("encoder") in DEPTH_ENCODERS else "vitb"
    track_characters = body.get("trackCharacters") is True
    project_id = body.get("projectId") or None
    folder_id = body.get("folderId") or None
    original_name = (body.get("originalName") or "")[:200]

    if not input_video_key:
        return Response({"error": "An input video is required."}, status=400)

    item_id = str(uuid.uuid4())
    now = int(time.time() * 1000)
    base = {
        "id": item_id,
        "kind": "depth",
        "status": "queued",
        "prompt": f"Depth map: {original_name}" if original_name else "Depth map",
        "model": DEPTH_MODEL_NAME,
        "aspectRatio": "16:9",
        "resolution": encoder,
        "trackCharacters": track_characters,
        "referenceVideos": [input_video_key],
        "projectId": project_id,
        "folderId": folder_id,
        "userId": str(request.user.id),
        "costCents": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    try:
        upsert_item(base)
        log_activity(str(request.user.id), "generate", {"id": item_id, "kind": "depth", "model": DEPTH_MODEL_NAME, "costCents": 0})
        return Response(base)
    except Exception as e:  # noqa: BLE001
        return Response({"error": str(e) or "Failed to save the generation request."}, status=500)


@api_view(["GET"])
def depth_status(request):
    item_id = request.GET.get("id")
    if not item_id:
        return Response({"error": "id is required."}, status=400)
    item = get_item(item_id)
    if not item or item.get("kind") != "depth":
        return Response({"error": "Not found."}, status=404)
    return Response(item)


@api_view(["GET"])
def worker_status(request):
    return Response(depth_jobs_service.read_depth_worker_status())


@api_view(["POST"])
@permission_classes([])
def worker_heartbeat(request):
    if not verify_worker_token(request):
        return _unauthorized()
    body = request.data or {}
    worker_id = (body.get("workerId") or "").strip()
    if not worker_id:
        return Response({"error": "workerId is required."}, status=400)
    depth_jobs_service.upsert_depth_worker_heartbeat({
        "workerId": worker_id,
        "label": (body.get("label") or None) and str(body.get("label"))[:200],
        "device": (body.get("device") or None) and str(body.get("device"))[:50],
        "status": "busy" if body.get("status") == "busy" else "idle",
        "currentJobId": body.get("currentJobId") or None,
        "ramLimitMb": round(body["ramLimitMb"]) if isinstance(body.get("ramLimitMb"), (int, float)) else None,
        "ramUsedMb": round(body["ramUsedMb"]) if isinstance(body.get("ramUsedMb"), (int, float)) else None,
    })
    return Response({"ok": True})


@api_view(["POST"])
@permission_classes([])
def worker_claim(request):
    if not verify_worker_token(request):
        return _unauthorized()
    body = request.data or {}
    worker_id = (body.get("workerId") or "").strip()
    if not worker_id:
        return Response({"error": "workerId is required."}, status=400)

    job = depth_jobs_service.claim_next_depth_job(worker_id)
    if not job:
        return Response({"job": None})

    ref_videos = job.get("referenceVideos")
    input_ref = ref_videos[0] if isinstance(ref_videos, list) and ref_videos else None
    if not input_ref:
        depth_jobs_service.complete_depth_job(job["id"], ok=False, error="No input video was attached to this job.")
        return Response({"job": None})

    try:
        input_video_url = storage.sign_stored_ref(input_ref, 30 * 60)
    except Exception as e:  # noqa: BLE001
        depth_jobs_service.complete_depth_job(
            job["id"], ok=False, error=f"Could not produce a download URL for the input video: {e}"
        )
        return Response({"job": None})

    return Response({
        "job": {
            "id": job["id"],
            "inputVideoUrl": input_video_url,
            "encoder": job.get("encoder") or "vitb",
            "trackCharacters": job.get("trackCharacters") is True,
        }
    })


@api_view(["POST"])
@permission_classes([])
def worker_progress(request):
    if not verify_worker_token(request):
        return _unauthorized()
    body = request.data or {}
    job_id = (body.get("jobId") or "").strip()
    percent = body.get("percent")
    if not job_id or not isinstance(percent, (int, float)):
        return Response({"error": "jobId and a numeric percent are required."}, status=400)
    message = body.get("message")
    depth_jobs_service.report_depth_progress(job_id, percent, str(message)[:300] if isinstance(message, str) else None)
    return Response({"ok": True})


@api_view(["POST"])
@permission_classes([])
def worker_upload_url(request):
    if not verify_worker_token(request):
        return _unauthorized()
    body = request.data or {}
    job_id = (body.get("jobId") or "").strip()
    if not job_id:
        return Response({"error": "jobId is required."}, status=400)
    key = f"depth-output/{job_id}.mp4"
    try:
        upload_url = storage.get_signed_upload_url(key, "video/mp4")
        return Response({"key": key, "uploadUrl": upload_url})
    except Exception as e:  # noqa: BLE001
        return Response({"error": str(e) or "Failed to create an upload URL."}, status=500)


@api_view(["POST"])
@permission_classes([])
def worker_complete(request):
    if not verify_worker_token(request):
        return _unauthorized()
    body = request.data or {}
    job_id = (body.get("jobId") or "").strip()
    if not job_id:
        return Response({"error": "jobId is required."}, status=400)

    if body.get("ok") is True:
        key = (body.get("key") or "").strip()
        if not key:
            return Response({"error": "key is required when ok=true."}, status=400)
        aspect_ratio = body.get("aspectRatio") if isinstance(body.get("aspectRatio"), str) else None
        depth_jobs_service.complete_depth_job(job_id, ok=True, url=f"/api/media/{key}", aspect_ratio=aspect_ratio)
        log_activity(None, "depth_complete", {"id": job_id})
    else:
        error = body.get("error")
        depth_jobs_service.complete_depth_job(
            job_id, ok=False, error=str(error)[:2000] if isinstance(error, str) else "Depth worker reported failure."
        )
        log_activity(None, "depth_failed", {"id": job_id, "error": error})

    return Response({"ok": True})
