"""Optional shot context and human review; independent of provider job state."""
import time
import uuid

from django.db import transaction
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import Generation
from .generations_service import row_to_item

EDITABLE = {"scene": 120, "shot": 120, "take": 120, "notes": 4000}
REVIEW_STATES = ("candidate", "needs_changes", "approved")


def production_context(raw, project_id):
    if not raw:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("Invalid shot context.")
    result = {}
    for key, maximum in EDITABLE.items():
        if key in raw:
            if not isinstance(raw[key], str) or len(raw[key]) > maximum:
                raise ValueError(f"{key} must be text of at most {maximum} characters.")
            result[key] = raw[key].strip()
    if raw.get("sourceGenerationId"):
        try:
            source_id = uuid.UUID(str(raw["sourceGenerationId"]))
        except (ValueError, TypeError):
            raise ValueError("Invalid source generation.")
        source = Generation.objects.filter(id=source_id).first()
        if not source:
            raise ValueError("The source generation no longer exists.")
        if raw.get("relation") not in ("clone", "continuation"):
            raise ValueError("Invalid generation relationship.")
        # Cross-project clones are legitimate; keep the source's project in the
        # snapshot so moving a take never silently changes its recorded origin.
        result.update(sourceGenerationId=str(source.id), relation=raw["relation"], sourceProjectId=str(source.project_id) if source.project_id else None)
        if raw["relation"] == "continuation":
            result["frame"] = "last"
        for key in ("scene", "shot"):
            if key not in result:
                result[key] = (source.production_metadata or {}).get(key, "")
    return result


@api_view(["GET", "PATCH"])
def production(request):
    try:
        item_id = uuid.UUID(str(request.query_params.get("id", "")))
    except ValueError:
        return Response({"error": "Invalid generation id."}, status=400)
    with transaction.atomic():
        queryset = Generation.objects.select_for_update() if request.method == "PATCH" else Generation.objects
        item = queryset.filter(id=item_id).first()
        if not item:
            return Response({"error": "Generation not found."}, status=404)
        metadata = dict(item.production_metadata or {})
        if request.method == "PATCH":
            body = request.data
            if not isinstance(body, dict) or set(body) - {*EDITABLE, "reviewStatus", "expectedRevision", "referenceNotes"}:
                return Response({"error": "Unsupported production metadata fields."}, status=400)
            if body.get("expectedRevision") != metadata.get("revision", 0):
                return Response({"error": "Another reviewer updated this take. Reload the current version before saving."}, status=409)
            for key, maximum in EDITABLE.items():
                if key in body:
                    if not isinstance(body[key], str) or len(body[key]) > maximum:
                        return Response({"error": f"{key} must be text of at most {maximum} characters."}, status=400)
                    metadata[key] = body[key].strip()
            if "referenceNotes" in body:
                notes = body["referenceNotes"]
                refs = [*(item.reference_images or []), *(item.reference_videos or [])]
                if not isinstance(notes, list) or len(notes) > len(refs):
                    return Response({"error": "Invalid continuity references."}, status=400)
                accepted = []
                for entry in notes:
                    if not isinstance(entry, dict) or entry.get("url") not in refs or not isinstance(entry.get("label"), str) or len(entry["label"]) > 120 or not isinstance(entry.get("approved"), bool):
                        return Response({"error": "Continuity references must match this take's recorded inputs."}, status=400)
                    previous = next((note for note in metadata.get("referenceNotes", []) if note["url"] == entry["url"]), {})
                    note = {"url": entry["url"], "label": entry["label"].strip(), "approved": entry["approved"]}
                    if not previous.get("approved") or previous.get("label") != note["label"]:
                        previous = {}
                    if note["approved"]:
                        note.update(reviewerName=previous.get("reviewerName", request.user.name), reviewerId=previous.get("reviewerId", str(request.user.id)), at=previous.get("at", int(time.time() * 1000)))
                    accepted.append(note)
                metadata["referenceNotes"] = accepted
            review = body.get("reviewStatus", metadata.get("reviewStatus", "candidate"))
            if review not in REVIEW_STATES:
                return Response({"error": "Invalid review state."}, status=400)
            now = int(time.time() * 1000)
            if review != metadata.get("reviewStatus", "candidate"):
                entry = {"status": review, "reviewerId": str(request.user.id), "reviewerName": request.user.name, "at": now}
                metadata["review"] = entry
                metadata["reviewHistory"] = [*(metadata.get("reviewHistory") or []), entry][-100:]
            metadata.update(reviewStatus=review, revision=metadata.get("revision", 0) + 1)
            item.production_metadata = metadata
            item.updated_at = now
            item.save(update_fields=["production_metadata", "updated_at"])
    source = Generation.objects.filter(id=metadata["sourceGenerationId"]).first() if metadata.get("sourceGenerationId") else None
    children = Generation.objects.filter(production_metadata__sourceGenerationId=str(item.id)).order_by("created_at")[:100]
    return Response({"item": row_to_item(item), "source": row_to_item(source) if source else None, "children": [row_to_item(child) for child in children]})
