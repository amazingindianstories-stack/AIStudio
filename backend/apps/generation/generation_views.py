"""Port of src/app/api/{generate/image,generate/video,generate/video/status,
queue/execute,queue/status}/route.js — the generation orchestration
surface. This is the highest-risk file in the whole migration: five
provider integrations, best-of-N, the spend gate, and several
provider-reports-its-own-billing reconciliations all meet here. Every
branch below has a numbered TS route as its source of truth; re-read that
route before changing the matching branch here.

No live provider call has been exercised for this file (unlike the pilot
CRUD / media / history phases, which were verified against production) —
doing so costs a real billed generation. Structural fidelity was verified
by porting each provider's own pure-logic test suite instead (see
apps/core/tests/test_*_provider.py) and by reading every branch against
its TS source line for line.
"""

import io
import os
import random
import re
import time
import tempfile
import uuid

import requests
from PIL import Image
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.assets.assets_service import read_assets
from apps.common.activity import log_activity
from apps.media import save_media, storage

from . import config, mock, pricing as pricing_lib, pricing_db, queue_service
from .best_of_spool import bounded_best_of, generate_and_spool_candidates, read_spooled_base64
from .face_judge import judge_candidate, judge_identity, select_best_candidate
from .generations_service import get_item as get_generation, row_to_item
from .image_prep import crispen, prep_reference
from .kling_input import build_kling_input
from .mentions import resolve_references, resolve_video_references
from .prompt_assembler import assemble_prompt
from .providers import gemini as gemini_provider
from .providers import higgsfield_mcp as hf
from .providers import kling as kling_provider
from .providers import omni as omni_provider
from .providers import seedance as seedance_provider


def _resolution_to_image_size(res: str | None) -> str:
    if res == "4K":
        return "4K"
    if res in ("2K", "1080p"):
        return "2K"
    return "1K"


NEXT_IMAGE_SIZE = {"1K": "2K", "2K": "4K", "4K": "4K"}


def _halve_for_delivery(b64: str) -> str:
    """SUPERSAMPLE delivery step: NEXT_IMAGE_SIZE is always exactly one
    step up, so halving the rendered image's actual pixel dimensions lands
    back on the originally requested size. Fail-open: returns input on
    error."""
    import base64 as b64mod

    try:
        buf = b64mod.b64decode(b64)
        with Image.open(io.BytesIO(buf)) as im:
            w, h = im.size
            resized = im.resize((round(w / 2), round(h / 2)), Image.LANCZOS)
            out = io.BytesIO()
            resized.save(out, format=im.format or "PNG")
            return b64mod.b64encode(out.getvalue()).decode()
    except Exception:
        return b64


def _sign_video_refs(refs: list[str]) -> list[str]:
    out = []
    for ref in refs:
        try:
            signed = storage.sign_stored_ref(ref)
            out.append(signed or ref)
        except Exception as e:
            raise RuntimeError(f"Reference clip could not be prepared for the provider. {e}") from e
    return out


def _to_provider_data_urls(refs: list[str]) -> list[str]:
    """Materialise stored reference images as base64 data URIs for native
    BytePlus Seedance — it fetches image_url.url from its own servers, and
    our media proxy is auth-gated, so the reference has to travel inline."""
    out = []
    for ref in refs:
        mime_type, data = storage.read_as_base64(ref)
        prepped = prep_reference(mime_type, data)
        mime_type, data = prepped["mimeType"], prepped["data"]
        if not re.match(r"^image/(jpeg|png)$", mime_type, re.IGNORECASE):
            try:
                import base64 as b64mod

                with Image.open(io.BytesIO(b64mod.b64decode(data))) as im:
                    rgb = im.convert("RGB") if im.mode in ("P", "CMYK", "RGBA") else im
                    out_buf = io.BytesIO()
                    rgb.save(out_buf, format="JPEG", quality=92)
                    data = b64mod.b64encode(out_buf.getvalue()).decode()
                    mime_type = "image/jpeg"
            except Exception as e:
                raise RuntimeError(f"Reference image could not be converted to JPEG for Seedance (was {mime_type}).") from e
        out.append(f"data:{mime_type.lower()};base64,{data}")
    return out


def _submit_video(base: dict) -> dict:
    """Create the provider task for a locked video job. Returns the item
    with taskId + status "running" (does not persist)."""
    item_id, prompt, aspect_ratio, resolution, duration, model, seed = (
        base["id"], base["prompt"], base["aspectRatio"], base.get("resolution"), base.get("duration"),
        base["model"], base.get("seed"),
    )

    if mock.is_mock():
        return {
            **base,
            "taskId": f"mock-{item_id}",
            "poster": mock.mock_placeholder(item_id, prompt, aspect_ratio, model),
            "status": "running",
            "updatedAt": int(time.time() * 1000),
        }

    ref_updates: dict = {}

    if omni_provider.is_omni_model(model):
        assembled = assemble_prompt(prompt, read_assets(), base.get("referenceImages") or [], aspect_ratio, "video")
        task_id = omni_provider.create_omni_video_task(assembled, aspect_ratio, duration or 4)

    elif hf.is_higgsfield_model(model):
        refs = base.get("referenceImages") or []
        media_ids = []
        if not refs:
            gen_res = gemini_provider.generate_image_gemini({"instruction": prompt, "groups": []}, aspect_ratio)
            ext = gen_res["mimeType"].split("/")[-1] or "png"
            auto_ref_url = storage.upload_base64(gen_res["base64"], f"references/{item_id}-auto.{ext}", ext)
            ref_updates["referenceImages"] = [auto_ref_url]
            media_ids.append(hf.mcp_upload_image(gen_res["base64"], gen_res["mimeType"]))
        else:
            for ref in refs:
                mime_type, data = storage.read_as_base64(ref)
                prepped = prep_reference(mime_type, data)
                media_ids.append(hf.mcp_upload_image(prepped["data"], prepped["mimeType"]))
        task_id = hf.mcp_generate_video(model, media_ids, prompt, aspect_ratio, duration, resolution)

    else:
        inlined = _to_provider_data_urls(base.get("referenceImages") or [])
        references = resolve_references(prompt, inlined)
        signed_video_refs = _sign_video_refs(resolve_video_references(prompt, base.get("referenceVideos") or []))
        # Multi-shot chaining (Phase 3.3) — reuses the same stored-ref →
        # inline data-URL materialisation referenceImages already goes
        # through; see queue/execute/route.js's identical comment.
        continuation_frame_url = base.get("continuationFrameUrl")
        first_frame = (
            {"dataUrl": _to_provider_data_urls([continuation_frame_url])[0]}
            if continuation_frame_url else None
        )
        task_id = seedance_provider.create_video_task(
            prompt, model, aspect_ratio, resolution, duration, references, signed_video_refs,
            base.get("generateAudio") is True, base.get("videoTaskMode") or "generate",
            seed, first_frame,
        )

    return {**base, **ref_updates, "taskId": task_id, "status": "running", "updatedAt": int(time.time() * 1000)}


@api_view(["POST"])
def generate_image(request):
    body = request.data or {}
    prompt = (body.get("prompt") or "").strip()
    aspect_ratio = body.get("aspectRatio") or "1:1"
    resolution = body.get("resolution")
    model = body.get("model") or "Nano Banana Pro"
    reference_images = body.get("referenceImages")
    project_id = body.get("projectId") or None
    folder_id = body.get("folderId") or None
    # "Regenerate with same seed" (Phase 3.1) — only honoured for models
    # config.supports_seed confirms; dropped silently elsewhere rather than
    # stored and never acted on. queue_execute backfills a fresh seed when
    # this is None and the model supports it.
    seed = body.get("seed") if config.supports_seed(model) and isinstance(body.get("seed"), int) else None

    if not prompt:
        return Response({"error": "Prompt is required."}, status=400)

    item_id = str(uuid.uuid4())
    now = int(time.time() * 1000)

    try:
        pricing_rows = pricing_db.read_pricing()
        cost_cents = pricing_lib.compute_cost_cents(
            {"kind": "image", "model": model, "resolution": resolution, "hasReferenceImage": bool(reference_images)},
            pricing_rows,
        )
        saved_refs = save_media.save_reference_images(reference_images, item_id) if reference_images else None
    except Exception as e:
        return Response({"error": str(e) or "Failed to prepare the generation request."}, status=500)

    base = {
        "id": item_id, "kind": "image", "status": "queued", "prompt": prompt, "model": model,
        "aspectRatio": aspect_ratio, "resolution": resolution, "referenceImages": saved_refs,
        "projectId": project_id, "folderId": folder_id, "userId": str(request.user.id),
        "costCents": cost_cents, "seed": seed, "createdAt": now, "updatedAt": now,
    }
    try:
        queue_service.upsert_item(base)
        log_activity(str(request.user.id), "generate", {"id": item_id, "kind": "image", "model": model, "costCents": cost_cents})
        return Response(base)
    except Exception as e:
        return Response({"error": str(e) or "Failed to save the generation request."}, status=500)


@api_view(["POST"])
@permission_classes([])
def generate_video(request):
    # Faithful to generate/video/route.js: getSession() is read but its
    # absence is NOT a 401 here (unlike generate/image) — user_id is
    # persisted as null for an anonymous submission. Not something to
    # "fix" without being asked; matching current behavior.
    body = request.data or {}
    prompt = (body.get("prompt") or "").strip()
    aspect_ratio = body.get("aspectRatio") or "16:9"
    resolution = body.get("resolution") or "1080p"
    model = body.get("model") or "Higgsfield Seedance 2.0"
    reference_images = body.get("referenceImages")
    project_id = body.get("projectId") or None
    folder_id = body.get("folderId") or None
    generate_audio = body.get("generateAudio") is True and config.supports_audio(model)
    reference_videos = (
        [v for v in (body.get("referenceVideos") or []) if isinstance(v, str) and v][: config.MAX_REFERENCE_VIDEOS]
        if config.supports_video_reference(model) else []
    )
    video_task_mode = body.get("videoTaskMode") if body.get("videoTaskMode") in config.VIDEO_TASK_MODES else "generate"
    duration = (
        (body.get("duration") or None) if video_task_mode == "edit" else (body.get("duration") or 5)
    )
    # "Regenerate with same seed" (Phase 3.1) — native BytePlus Seedance only;
    # see config.supports_seed's doc comment for why Omni/Higgsfield/Kling are
    # excluded. Dropped silently for unsupported models, same convention
    # generate_audio uses just above.
    seed = body.get("seed") if config.supports_seed(model) and isinstance(body.get("seed"), int) else None
    # Multi-shot chaining (Phase 3.3) — "Continue this shot" hands over a
    # data URL of a frame extracted from a previous generation. Same gate/
    # drop convention as generate_audio/seed above.
    continuation_frame = (
        body.get("continuationFrame")
        if config.supports_first_frame_continuation(model) and isinstance(body.get("continuationFrame"), str)
        else None
    )

    if not prompt:
        return Response({"error": "Prompt is required."}, status=400)

    max_reference_images = config.max_reference_images_for_video_model(model)
    if (
        max_reference_images is not None
        and isinstance(reference_images, list)
        and len(reference_images) > max_reference_images
    ):
        return Response(
            {"error": f"{model} accepts at most {max_reference_images} reference images (got {len(reference_images)})."},
            status=400,
        )

    raw_ref_videos = body.get("referenceVideos")
    if isinstance(raw_ref_videos, list) and len(raw_ref_videos) > config.MAX_REFERENCE_VIDEOS and config.supports_video_reference(model):
        return Response(
            {"error": f"{model} accepts at most {config.MAX_REFERENCE_VIDEOS} reference clips (got {len(raw_ref_videos)})."},
            status=400,
        )
    if re.search(r"seedance.*mini", model, re.IGNORECASE) and (resolution or "") not in ("480p", "720p"):
        return Response({"error": f"Seedance 2.0 Mini supports 480p/720p only (got {resolution})."}, status=400)

    # Seedance 2.0/2.5 take any integer duration within BytePlus's documented
    # bounds rather than a fixed enum (see config.duration_range_for_model) —
    # reject outside that range up front, mirroring generate/video/route.js.
    # Edit forces duration to -1 (match source) at the provider layer
    # regardless of what's sent, so it's exempt; Extend passes through a
    # real duration when given, so it stays covered.
    if video_task_mode != "edit":
        duration_range = config.duration_range_for_model(model)
        if duration_range is not None and duration is not None and (
            not isinstance(duration, int) or duration < duration_range["min"] or duration > duration_range["max"]
        ):
            return Response(
                {"error": f"{model} supports {duration_range['min']}-{duration_range['max']}s durations (got {duration})."},
                status=400,
            )

    if video_task_mode != "generate":
        if not config.supports_video_edit_extend(model):
            return Response({"error": f"{model} does not support {'Edit' if video_task_mode == 'edit' else 'Extend'}."}, status=400)
        if not reference_videos:
            return Response(
                {"error": f"Attach a reference clip to {'edit' if video_task_mode == 'edit' else 'extend'} a video."},
                status=400,
            )

    if omni_provider.is_omni_model(model):
        if aspect_ratio not in config.aspect_ratios_for_model(model, "video"):
            return Response({"error": f"Gemini Omni Flash supports 16:9/9:16 aspect ratios only (got {aspect_ratio})."}, status=400)
        if (duration or 0) not in config.durations_for_model(model):
            return Response(
                {"error": f"Gemini Omni Flash supports {'/'.join(str(d) for d in config.durations_for_model(model))}s durations (got {duration})."},
                status=400,
            )
        if (resolution or "") not in config.resolutions_for_model(model, "video"):
            return Response(
                {"error": f"Gemini Omni Flash supports {'/'.join(config.resolutions_for_model(model, 'video'))} only (got {resolution})."},
                status=400,
            )

    item_id = str(uuid.uuid4())
    now = int(time.time() * 1000)

    try:
        cost_cents = pricing_lib.compute_cost_cents(
            {"kind": "video", "model": model, "resolution": resolution, "duration": duration, "generateAudio": generate_audio},
            pricing_db.read_pricing(),
        )
        saved_refs = save_media.save_reference_images(reference_images, item_id) if reference_images else None
        # Suffixed id, not the bare generation id — save_reference_images
        # numbers its own outputs from 0 per call, so reusing item_id here
        # would collide with referenceImages' own references/{id}-0.ext when
        # both are present on the same request.
        continuation_frame_url = (
            save_media.save_reference_images([continuation_frame], f"{item_id}-continuation")[0]
            if continuation_frame else None
        )
    except Exception as e:
        return Response({"error": str(e) or "Failed to prepare the generation request."}, status=500)

    base = {
        "id": item_id, "kind": "video", "status": "queued", "prompt": prompt, "model": model,
        "aspectRatio": aspect_ratio, "resolution": resolution, "duration": duration,
        "referenceImages": saved_refs, "referenceVideos": reference_videos or None,
        "continuationFrameUrl": continuation_frame_url,
        "generateAudio": generate_audio, "videoTaskMode": video_task_mode if video_task_mode != "generate" else None,
        "projectId": project_id, "folderId": folder_id, "userId": str(request.user.id) if request.user else None,
        "costCents": cost_cents, "seed": seed, "createdAt": now, "updatedAt": now,
    }
    try:
        queue_service.upsert_item(base)
        log_activity(str(request.user.id) if request.user else None, "generate", {"id": item_id, "kind": "video", "model": model, "costCents": cost_cents})
        return Response(base)
    except Exception as e:
        return Response({"error": str(e) or "Failed to save the generation request."}, status=500)


@api_view(["GET"])
def queue_status(request):
    item_id = request.query_params.get("id")
    if not item_id:
        return Response({"error": "Missing id"}, status=400)
    status_obj = queue_service.get_queue_position(item_id)
    if not status_obj:
        return Response({"error": "Not found"}, status=404)
    return Response(status_obj)


POLL_TIMEOUT_MS = 30 * 60 * 1000


@api_view(["GET"])
@permission_classes([])
def video_status(request):
    # Faithful to generate/video/status/route.js: that route has no auth
    # check at all in the TS source. Not introducing one here without being
    # asked — see the note on generate_video above.
    item_id = request.query_params.get("id")
    if not item_id:
        return Response({"error": "Missing id."}, status=400)
    gen = get_generation(item_id)
    if not gen:
        return Response({"error": "Not found."}, status=404)
    item = row_to_item(gen)
    if item["status"] in ("succeeded", "failed"):
        return Response(item)

    # AGE ALONE MUST NEVER FAIL A JOB THE PROVIDER MIGHT HAVE FINISHED.
    #
    # This check used to run here, before the provider was asked, so the first
    # poll after the 30-minute mark failed the row without ever calling the
    # provider. Polling is not continuous — it stops when the tab is closed and
    # resumes when the user returns — so "older than 30 minutes" mostly means
    # "nobody was watching". A user who came back later had their finished, and
    # billed, video replaced with a timeout error, terminally. Measured on
    # production: every row carrying this error had a real taskId, and their
    # created→failed gaps (38.8/47.4/286.1 min) all sat past the threshold
    # rather than on it, i.e. the failing poll followed a gap in polling.
    #
    # The timeout now applies only where it cannot destroy a result: below,
    # once the provider itself has said the job is still pending.
    aged_out = not mock.is_mock() and int(time.time() * 1000) - item["createdAt"] > POLL_TIMEOUT_MS

    if not item.get("taskId"):
        # Nothing to ask — never submitted, so age is all there is.
        if aged_out:
            failed = {**item, "status": "failed", "error": "Generation timed out — the provider never returned a result.", "updatedAt": int(time.time() * 1000)}
            queue_service.upsert_item(failed)
            return Response(failed)
        return Response(item)

    try:
        if mock.is_mock():
            if int(time.time() * 1000) - item["createdAt"] > 6000:
                done = {**item, "status": "succeeded", "url": item.get("poster"), "updatedAt": int(time.time() * 1000)}
                queue_service.upsert_item(done)
                return Response(done)
            return Response(item)

        if omni_provider.is_omni_model(item["model"]):
            result = omni_provider.get_omni_video_status(item["taskId"])
            if result["status"] == "succeeded" and result.get("videoBase64"):
                ext = "webm" if "webm" in (result.get("mimeType") or "") else "mp4"
                url = None
                save_error = None
                for attempt in (1, 2):
                    try:
                        url = save_media.save_base64(result["videoBase64"], ext, item["id"])
                        break
                    except Exception as e:
                        save_error = e
                        if attempt == 1:
                            time.sleep(1)
                if url:
                    done = {**item, "status": "succeeded", "url": url, "updatedAt": int(time.time() * 1000)}
                    queue_service.upsert_item(done)
                    return Response(done)
                failed = {**item, "status": "failed", "error": f"Video generated but failed to save: {save_error}", "updatedAt": int(time.time() * 1000)}
                queue_service.upsert_item(failed)
                return Response(failed)
            if result["status"] == "failed":
                failed = {**item, "status": "failed", "error": result.get("error") or "Generation failed.", "moderationBlocked": result.get("moderationBlocked"), "updatedAt": int(time.time() * 1000)}
                queue_service.upsert_item(failed)
                return Response(failed)
            if result["status"] == "succeeded":
                failed = {**item, "status": "failed", "error": "Omni reported success but returned no video.", "updatedAt": int(time.time() * 1000)}
                queue_service.upsert_item(failed)
                return Response(failed)
            updated = {**item, "status": result["status"], "updatedAt": int(time.time() * 1000)}
            queue_service.upsert_item(updated)
            return Response(updated)

        if hf.is_higgsfield_model(item["model"]):
            result = hf.mcp_job_status(item["taskId"])
            video_url = result.get("url")
        else:
            result = seedance_provider.get_video_task(item["taskId"])
            video_url = result.get("videoUrl")

        if result["status"] == "succeeded" and video_url:
            try:
                local_url = save_media.save_from_url(video_url, "mp4", item["id"])
            except Exception:
                local_url = video_url
            cost_cents = item.get("costCents")
            if re.search(r"seedance 2\.5", item["model"], re.IGNORECASE):
                total_tokens = result.get("totalTokens")
                had_video_input = bool(item.get("referenceVideos"))
                actual = pricing_lib.compute_seedance_token_cost_cents(item["model"], total_tokens, had_video_input, pricing_db.read_pricing())
                if actual is not None:
                    cost_cents = actual
            done = {**item, "status": "succeeded", "url": local_url, "costCents": cost_cents, "updatedAt": int(time.time() * 1000)}
            queue_service.upsert_item(done)
            return Response(done)

        if result["status"] == "failed":
            blocked = seedance_provider.is_moderation_message(result.get("error") or "")
            failed = {
                **item, "status": "failed",
                "error": seedance_provider.MODERATION_MESSAGE if blocked else (result.get("error") or "Generation failed."),
                "moderationBlocked": blocked, "updatedAt": int(time.time() * 1000),
            }
            queue_service.upsert_item(failed)
            return Response(failed)

        # Still running/queued. The one place the age check is safe: the
        # provider has just said it has no result, so failing cannot throw one
        # away.
        if aged_out:
            failed = {**item, "status": "failed", "error": "Generation timed out — the provider never returned a result.", "updatedAt": int(time.time() * 1000)}
            queue_service.upsert_item(failed)
            return Response(failed)
        updated = {**item, "status": result["status"], "updatedAt": int(time.time() * 1000)}
        queue_service.upsert_item(updated)
        return Response(updated)
    except Exception as e:
        # Transient poll error (network blip, provider 502/503, a momentary MCP
        # socket drop) — the DB row is untouched, still "running"/"queued". The
        # response must NOT claim status "failed": the frontend's pollVideo()
        # only reads this JSON body and stops polling the instant it sees a
        # terminal status, with no way to tell "really failed" apart from "the
        # poll itself failed" — reporting failure here would silently lose a
        # render that finishes seconds later on the provider's side. Mirrors
        # the same fix in generate/video/status/route.js; keep both in sync.
        #
        # Deliberately omitting "id" from the body (rather than spreading
        # **item) is what makes this safe: pollVideo() only patches state and
        # evaluates the terminal-status check inside `if (item?.id)`, so a
        # body with no "id" falls through to its trailing retry timer
        # untouched. The 502 status is for logs/monitoring, not client
        # branching.
        return Response({"error": f"Poll error: {e}", "transientError": True}, status=502)


@api_view(["POST"])
def queue_execute(request):
    body = request.data or {}
    item_id = body.get("id")
    if not item_id:
        return Response({"error": "Job ID is required."}, status=400)

    # Admission is checked before the lock is acquired, not after: lock_job()
    # flips the row to "running" unconditionally and there is no unlock path
    # to undo that, so rejecting an inadmissible job afterward would strand
    # it "running" until the stale-job reaper caught it minutes later. A
    # plain read has no such side effect.
    #
    # This used to be an ownership check instead (only the job's owner or an
    # admin could call execute). That was addressing the wrong risk: the real
    # hazard here was never "the wrong teammate ran a ready job" — it's that
    # this route had NO admission control of its own. get_queue_position()
    # (also used by /api/queue/status) is where MAX_CONCURRENT and the Gemini
    # spend-window gate actually live; this route used to trust the client to
    # only call it once /api/queue/status reported position 0, which any
    # direct POST (a retry bug, a race) could simply skip, bypassing both the
    # concurrency cap and the spend throttle spend_window.py exists to
    # enforce. Re-running the same admission check here closes that
    # regardless of who's calling — including the legitimate case of a
    # teammate's tab adopting a job whose owner's tab has gone away (see
    # adoptOrphanedJobs in store.js), which an ownership-only gate would have
    # blocked outright. Mirrors the same fix in queue/execute/route.js.
    position = queue_service.get_queue_position(item_id)
    if not position:
        return Response({"error": "Job not found."}, status=404)
    if position["position"] != 0:
        # Not actually our turn (or the spend window won't admit it yet).
        # Report the same shape /api/queue/status uses so the client's
        # existing heldForBudget/backoff handling applies uniformly.
        return Response({**position, "notAdmitted": True})

    locked = queue_service.lock_job(item_id)
    if not locked:
        return Response({"error": "Job is already running or invalid."}, status=400)

    gen = get_generation(item_id)
    if not gen:
        return Response({"error": "Job not found."}, status=404)
    base = row_to_item(gen)

    prompt, aspect_ratio, resolution, model, reference_images = (
        base["prompt"], base["aspectRatio"], base.get("resolution"), base["model"], base.get("referenceImages")
    )
    cost_cents = base.get("costCents") or 0
    # Reproducibility seed (Phase 3.1) — mirrors queue/execute/route.js
    # exactly: only filled in for models config.supports_seed confirms, and
    # only generated fresh when the row doesn't already carry one (so
    # "regenerate with same seed" has something concrete to reuse).
    seed = base.get("seed")
    if config.supports_seed(model) and seed is None:
        seed = random.randint(0, 2147483647)
    aspect_ratio_out = aspect_ratio

    if base["kind"] == "video":
        try:
            running = _submit_video({**base, "seed": seed})
            queue_service.upsert_item(running)
            return Response(running)
        except seedance_provider.SeedanceError as e:
            failed = {**base, "status": "failed", "error": str(e), "moderationBlocked": e.code == "moderation", "updatedAt": int(time.time() * 1000)}
            queue_service.upsert_item(failed)
            return Response(failed)
        except Exception as e:
            failed = {**base, "status": "failed", "error": str(e) or "Video task creation failed.", "updatedAt": int(time.time() * 1000)}
            queue_service.upsert_item(failed)
            return Response(failed)

    try:
        # Winning best-of-N candidate's judge score (Phase 3.5) — mirrors
        # route.js's identical placement/reasoning: declared before every
        # branch so it's in scope for the single `done` dict below, and only
        # ever set inside the Gemini best-of-N branch further down.
        judge_score = None
        if mock.is_mock():
            time.sleep(0.7)
            url = mock.mock_placeholder(item_id, prompt, aspect_ratio, model)
        elif hf.is_higgsfield_model(model):
            assembled = assemble_prompt(prompt, read_assets(), reference_images or [])
            is_nano_banana = bool(re.search(r"nano banana", model, re.IGNORECASE))
            refs = (reference_images or []) if is_nano_banana else (reference_images or [])[:1]
            media_ids = None
            if refs:
                media_ids = []
                for ref in refs:
                    mime_type, data = storage.read_as_base64(ref)
                    prepped = prep_reference(mime_type, data)
                    media_ids.append(hf.mcp_upload_image(prepped["data"], prepped["mimeType"]))
            quality = "1.5k" if resolution == "1K" else "2k"
            nb_resolution = (resolution or "2K").lower()
            job_id = hf.mcp_generate_image(
                model, assembled["instruction"], aspect_ratio,
                None if is_nano_banana else quality, nb_resolution if is_nano_banana else None, media_ids,
            )
            done = hf.mcp_await_job(job_id)
            if done["status"] != "succeeded" or not done.get("url"):
                raise RuntimeError(done.get("error") or "Higgsfield image generation failed.")
            url = save_media.save_from_url(done["url"], "png", item_id)
        elif kling_provider.is_kling_model(model):
            assembled = assemble_prompt(prompt, read_assets(), reference_images or [], aspect_ratio)
            kling_input = build_kling_input(assembled, model)
            refs = [kling_provider.prep_kling_reference(kling_input["reference"]["mimeType"], kling_input["reference"]["data"])] if kling_input["reference"] else []
            result = kling_provider.generate_image_kling(model, kling_input["prompt"], aspect_ratio, resolution, refs)
            actual = pricing_lib.kling_units_to_cents(result.get("unitDeduction"))
            if actual is not None:
                cost_cents = actual
            fetched = requests.get(result["url"], timeout=60)
            if not fetched.ok:
                raise RuntimeError(f"Kling produced an image but it could not be downloaded (http {fetched.status_code}).")
            image_bytes = fetched.content
            with Image.open(io.BytesIO(image_bytes)) as im:
                w, h = im.size
            measured = kling_provider.nearest_kling_aspect_ratio(w, h)
            if measured and measured != aspect_ratio:
                aspect_ratio_out = measured
            import base64 as b64mod

            url = save_media.save_base64(b64mod.b64encode(image_bytes).decode(), "png", item_id)
        else:
            assets = read_assets()
            assembled = assemble_prompt(prompt, assets, reference_images or [], aspect_ratio)
            requested_size = _resolution_to_image_size(resolution)
            supersample_on = os.environ.get("SUPERSAMPLE") == "1"
            render_size = NEXT_IMAGE_SIZE[requested_size] if supersample_on else requested_size
            if supersample_on and render_size != requested_size:
                cost_cents = pricing_lib.compute_cost_cents({"kind": "image", "model": model, "resolution": render_size}, pricing_db.read_pricing())

            best_of = bounded_best_of(os.environ.get("FACE_BEST_OF"), render_size) if assembled.get("judgeFace") else 1

            if best_of > 1:
                # Per-candidate seed offset, not the same seed repeated N
                # times. Candidates run serially and are immediately spooled
                # so a request never retains N full-resolution base64 strings.
                # an identical seed across candidates would collapse
                # best-of-N's diversity to one image N times over.
                with tempfile.TemporaryDirectory(prefix="veevee-best-of-") as directory:
                    candidates, errors = generate_and_spool_candidates(
                        best_of,
                        directory,
                        lambda i: gemini_provider.generate_image_gemini(
                            assembled, aspect_ratio, render_size, seed + i if seed is not None else None
                        ),
                    )
                    if not candidates:
                        raise errors[0] if errors else RuntimeError("Image generation failed.")
                    cost_cents = cost_cents * len(candidates)
                    scores = []
                    for candidate in candidates:
                        data = read_spooled_base64(candidate)
                        if os.environ.get("JUDGE_COMPOSITE") == "1":
                            scores.append(judge_candidate(assembled["judgeFace"], {"mimeType": candidate["mimeType"], "data": data}))
                        else:
                            scores.append(judge_identity(assembled["judgeFace"], {"mimeType": candidate["mimeType"], "data": data}))
                    if os.environ.get("JUDGE_COMPOSITE") == "1":
                        best = select_best_candidate(scores, 8)
                        judge_score = scores[best] if scores[best] is not None else None
                    else:
                        best = 0
                        for i in range(1, len(scores)):
                            if (scores[i] if scores[i] is not None else -1) > (scores[best] if scores[best] is not None else -1):
                                best = i
                        judge_score = {"identity": scores[best]} if scores[best] is not None else None
                    base64_out = read_spooled_base64(candidates[best])
                    mime_type = candidates[best]["mimeType"]
            else:
                result = gemini_provider.generate_image_gemini(assembled, aspect_ratio, render_size, seed)
                base64_out, mime_type = result["base64"], result["mimeType"]

            if os.environ.get("POST_CRISPEN") == "1":
                prepped = crispen(mime_type, base64_out)
                base64_out, mime_type = prepped["data"], prepped["mimeType"]
            if supersample_on and render_size != requested_size:
                base64_out = _halve_for_delivery(base64_out)

            ext = "jpg" if "jpeg" in mime_type else "png"
            url = save_media.save_base64(base64_out, ext, item_id)

        done = {**base, "status": "succeeded", "url": url, "aspectRatio": aspect_ratio_out, "costCents": cost_cents, "seed": seed, "judgeScore": judge_score, "updatedAt": int(time.time() * 1000)}
        queue_service.upsert_item(done)
        return Response(done)
    except Exception as e:
        failed = {**base, "status": "failed", "error": str(e) or "Image generation failed.", "updatedAt": int(time.time() * 1000)}
        queue_service.upsert_item(failed)
        return Response(failed)
