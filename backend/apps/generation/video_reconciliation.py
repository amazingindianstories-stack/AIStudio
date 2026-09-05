import base64
import os
import subprocess
import tempfile
import time

import requests
from django.db.models import F

from apps.media import save_media, storage

from . import mock, pricing as pricing_lib, pricing_db
from .face_judge import judge_candidate, judge_identity, select_best_candidate
from .generations_service import row_to_item
from .models import Generation
from .providers import higgsfield_mcp as hf
from .providers import omni as omni_provider
from .providers import seedance as seedance_provider


POLL_BASE_MS = 4_000
POLL_MAX_MS = 60_000
STALE_MS = 45 * 60 * 1000
RECONCILIATION_LIMIT = 5


def retry_after_ms(count):
    return min(POLL_MAX_MS, POLL_BASE_MS * (2 ** max(0, min(10, int(count or 1) - 1))))


def _expected(item):
    return Generation.objects.filter(
        id=item["id"], kind="video", status=item["status"],
        updated_at=item["updatedAt"], task_id=item["taskId"],
    )


def _current(item_id):
    row = Generation.objects.filter(id=item_id).first()
    return row_to_item(row) if row else None


def _poll_error(item):
    updated = _expected(item).update(
        poll_error_count=F("poll_error_count") + 1,
        last_poll_error_at=int(time.time() * 1000),
    )
    if not updated:
        return {"kind": "raced"}
    row = Generation.objects.get(id=item["id"])
    return {"kind": "poll_error", "pollErrorCount": row.poll_error_count, "retryAfterMs": retry_after_ms(row.poll_error_count)}


def _pending(item):
    updated = _expected(item).update(poll_error_count=0, last_poll_error_at=None)
    if not updated:
        return {"kind": "raced"}
    return {"kind": "pending", "item": _current(item["id"])}


def _terminal(item, **values):
    mapping = {
        "status": values["status"],
        "url": values.get("url"),
        "error": values.get("error"),
        "moderation_blocked": values.get("moderationBlocked"),
        "updated_at": values.get("updatedAt", int(time.time() * 1000)),
        "poll_error_count": 0,
        "last_poll_error_at": None,
    }
    for camel, snake in (
        ("aspectRatio", "aspect_ratio"), ("candidateTaskIds", "candidate_task_ids"),
        ("judgeScore", "judge_score"), ("costCents", "cost_cents"), ("costBasis", "cost_basis"),
    ):
        if camel in values:
            mapping[snake] = values[camel]
    if not _expected(item).update(**mapping):
        return {"kind": "raced"}
    return {"kind": values["status"], "item": _current(item["id"])}


def _extract_last_frame(url):
    import imageio_ffmpeg

    with tempfile.TemporaryDirectory(prefix="veevee-video-judge-") as directory:
        video_path = os.path.join(directory, "candidate.mp4")
        frame_path = os.path.join(directory, "frame.jpg")
        response = requests.get(url, timeout=60)
        response.raise_for_status()
        with open(video_path, "wb") as handle:
            handle.write(response.content)
        subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-sseof", "-0.1", "-i", video_path, "-frames:v", "1", "-y", frame_path],
            check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        with open(frame_path, "rb") as handle:
            return {"mimeType": "image/jpeg", "data": base64.b64encode(handle.read()).decode()}


def _resolve_best_of(item):
    results = []
    for task_id in [item["taskId"], *(item.get("candidateTaskIds") or [])]:
        results.append({"taskId": task_id, **seedance_provider.get_video_task(task_id)})
    if any(result["status"] not in {"succeeded", "failed"} for result in results):
        return _pending(item)
    succeeded = [result for result in results if result["status"] == "succeeded" and result.get("videoUrl")]
    if not succeeded:
        blocked = any(seedance_provider.is_moderation_message(result.get("error") or "") for result in results)
        return _terminal(
            item, status="failed",
            error=seedance_provider.MODERATION_MESSAGE if blocked else next((r.get("error") for r in results if r.get("error")), "All candidates failed to generate."),
            moderationBlocked=blocked, candidateTaskIds=None,
        )

    winner = succeeded[0]
    judge_score = None
    if item.get("referenceImages") and len(succeeded) > 1:
        mime_type, data = storage.read_as_base64(item["referenceImages"][0])
        reference = {"mimeType": mime_type, "data": data}
        judged = []
        for result in succeeded:
            try:
                judged.append((result, _extract_last_frame(result["videoUrl"])))
            except Exception:
                pass
        if len(judged) > 1:
            if os.environ.get("JUDGE_COMPOSITE") == "1":
                scores = [judge_candidate(reference, frame) for _, frame in judged]
                best = select_best_candidate(scores, 8)
                winner, judge_score = judged[best][0], scores[best]
            else:
                scores = [judge_identity(reference, frame) for _, frame in judged]
                best = max(range(len(scores)), key=lambda index: scores[index] if scores[index] is not None else -1)
                winner = judged[best][0]
                judge_score = {"identity": scores[best]} if scores[best] is not None else None
    try:
        url = save_media.save_from_url(winner["videoUrl"], "mp4", item["id"])
    except Exception:
        url = winner["videoUrl"]
    return _terminal(item, status="succeeded", url=url, candidateTaskIds=None, judgeScore=judge_score)


def advance_video_status(item, source="browser"):
    if item["status"] in {"succeeded", "failed"}:
        return {"kind": item["status"], "item": item}
    if not item.get("taskId"):
        return {"kind": "pending", "item": item}
    try:
        if not mock.is_mock() and item.get("candidateTaskIds"):
            return _resolve_best_of(item)
        if mock.is_mock():
            if int(time.time() * 1000) - item["createdAt"] <= 6000:
                return {"kind": "pending", "item": item}
            return _terminal(item, status="succeeded", url=item.get("poster"))
        if omni_provider.is_omni_model(item["model"]):
            result = omni_provider.get_omni_video_status(item["taskId"])
            if result["status"] == "succeeded" and result.get("videoBase64"):
                ext = "webm" if "webm" in (result.get("mimeType") or "") else "mp4"
                saved = save_media.save_base64(result["videoBase64"], ext, item["id"])
                return _terminal(item, status="succeeded", url=saved)
            if result["status"] == "failed":
                return _terminal(item, status="failed", error=result.get("error") or "Generation failed.", moderationBlocked=result.get("moderationBlocked"))
            if result["status"] == "succeeded":
                return _terminal(item, status="failed", error="Omni reported success but returned no video.")
            return _pending(item)

        result = hf.mcp_job_status(item["taskId"]) if hf.is_higgsfield_model(item["model"]) else seedance_provider.get_video_task(item["taskId"])
        video_url = result.get("url") or result.get("videoUrl")
        if result["status"] == "succeeded" and video_url:
            try:
                url = save_media.save_from_url(video_url, "mp4", item["id"])
            except Exception:
                url = video_url
            cost_cents = item.get("costCents") or 0
            cost_basis = item.get("costBasis") or "estimated"
            if "seedance 2.5" in item["model"].lower():
                actual = pricing_lib.compute_seedance_token_cost_cents(
                    item["model"], result.get("totalTokens"), bool(item.get("referenceVideos")), pricing_db.read_pricing()
                )
                if actual is not None:
                    cost_cents, cost_basis = actual, "reconciled"
            return _terminal(item, status="succeeded", url=url, costCents=cost_cents, costBasis=cost_basis)
        if result["status"] == "succeeded":
            return _terminal(item, status="failed", error="Provider reported success but returned no video.")
        if result["status"] == "failed":
            blocked = seedance_provider.is_moderation_message(result.get("error") or "")
            return _terminal(item, status="failed", error=seedance_provider.MODERATION_MESSAGE if blocked else result.get("error") or "Generation failed.", moderationBlocked=blocked)
        return _pending(item)
    except Exception:
        return _poll_error(item)


def run_video_reconciliation(now=None, limit=RECONCILIATION_LIMIT):
    now = int(time.time() * 1000) if now is None else now
    rows = Generation.objects.filter(
        kind="video", status__in=["queued", "running"], task_id__isnull=False,
        updated_at__lte=now - STALE_MS,
    ).order_by("updated_at", "created_at", "id")[: min(RECONCILIATION_LIMIT, max(0, limit))]
    counts = {"ok": True, "checked": 0, "succeeded": 0, "failed": 0, "pending": 0, "pollErrors": 0, "raced": 0}
    for row in rows:
        counts["checked"] += 1
        outcome = advance_video_status(row_to_item(row), source="cron")
        key = {"poll_error": "pollErrors", "raced": "raced"}.get(outcome["kind"], outcome["kind"])
        counts[key] += 1
    return counts
