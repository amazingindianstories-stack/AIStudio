import math
import uuid
from django.db import transaction
from apps.authentication.session import lookup
from apps.canvas.views import node_route, reply, failure, body, property_of, name_value, truthy
from apps.admin_dashboard.admin_api import number, rounded, MISSING
from apps.common.responses import log_activity
from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.serialization import generation_item
from apps.library.services.naming import assign_generation_naming
from apps.media.storage import get_storage
from .auth import worker_authorized
from . import depth


def cut(value, limit):
    return value.encode('utf-16-le', errors='surrogatepass')[:limit*2].decode('utf-16-le', errors='surrogatepass') if isinstance(value, str) else None


def integer(value):
    return type(value) in (int, float) and math.isfinite(value) and value == int(value)


def stale(request):
    return reply(request, {'error': 'STALE_CLAIM'}, 409)


@node_route(['POST'])
def worker(request, operation):
    if not worker_authorized(request):
        return reply(request, {'error': 'Unauthorized.'}, 401)
    try:
        data = body(request)
        get = lambda key: property_of(data, key)
        if operation in ('claim', 'heartbeat'):
            worker_id = name_value(get('workerId'))
            if not worker_id:
                return reply(request, {'error': 'workerId is required.'}, 400)
            protocol = int(get('protocolVersion')) if integer(get('protocolVersion')) else 1
            if operation == 'heartbeat':
                fields = dict(label=cut(get('label'), 200), device=cut(get('device'), 50),
                    status='busy' if get('status') == 'busy' else 'idle', protocol_version=protocol)
                for source, target in [('currentJobId', 'current_job_id'), ('currentClaimId', 'current_claim_id')]:
                    fields[target] = get(source) if isinstance(get(source), str) else None
                for source, target in [('ramLimitMb', 'ram_limit_mb'), ('ramUsedMb', 'ram_used_mb')]:
                    value = get(source)
                    fields[target] = rounded(value) if type(value) in (int, float) and math.isfinite(value) else None
                depth.heartbeat(worker_id, **fields)
                return reply(request, {'ok': True})
            row = depth.claim_next(worker_id, protocol)
            if row is None:
                return reply(request, {'job': None})
            reference = row.reference_videos[0] if isinstance(row.reference_videos, list) and row.reference_videos else None
            if not truthy(reference):
                depth.complete(row.id, row.depth_claim_id, ok=False, error='No input video was attached to this job.')
                return reply(request, {'job': None})
            try:
                url = get_storage().signed_read_url(reference, 30*60)
            except Exception as error:
                depth.complete(row.id, row.depth_claim_id, ok=False, error=f'Could not produce a download URL for the input video: {error}')
                return reply(request, {'job': None})
            result = {'id': str(row.id), 'inputVideoUrl': url, 'encoder': row.resolution if row.resolution is not None else 'vitb',
                      'trackCharacters': row.track_characters is True}
            if row.depth_claim_id: result['claimId'] = str(row.depth_claim_id)
            return reply(request, {'job': result})
        job_id = name_value(get('jobId'))
        claim_id = name_value(get('claimId')) if isinstance(get('claimId'), str) else ''
        if operation == 'progress':
            percent = number(data.get('percent', MISSING) if isinstance(data, dict) else MISSING)
            if not job_id or not math.isfinite(percent):
                return reply(request, {'error': 'jobId and a numeric percent are required.'}, 400)
            updated = depth.progress(job_id, claim_id, min(100, max(0, rounded(percent))), cut(get('message'), 300))
            return reply(request, {'ok': True}) if updated else stale(request)
        if not job_id:
            return reply(request, {'error': 'jobId is required.'}, 400)
        key = f'depth-output/{job_id}/{claim_id}.mp4' if claim_id else f'depth-output/{job_id}.mp4'
        if operation == 'upload-url':
            if not depth.active_claim(job_id, claim_id).exists(): return stale(request)
            try:
                return reply(request, {'key': key, 'uploadUrl': get_storage().signed_upload_url(key, 'video/mp4')})
            except Exception:
                return reply(request, {'error': 'Failed to create an upload URL.'}, 500)
        ok = get('ok') is True
        if ok:
            key = key if claim_id else name_value(get('key'))
            if not key:
                return reply(request, {'error': 'key is required when ok=true.'}, 400)
        updated = depth.complete(job_id, claim_id, ok=ok, url=f'/api/media/{key}',
            aspect_ratio=get('aspectRatio') if isinstance(get('aspectRatio'), str) else None,
            error=cut(get('error'), 2000))
        if not updated: return stale(request)
        detail = {'id': job_id}
        if not ok and isinstance(data, dict) and 'error' in data: detail['error'] = data['error']
        log_activity(None, 'depth_complete' if ok else 'depth_failed', detail)
        return reply(request, {'ok': True})
    except Exception:
        return failure()


@node_route(['GET'])
def worker_status(request):
    if lookup(request) is None: return reply(request, {'error': 'Unauthorized.'}, 401)
    try:
        return reply(request, depth.status())
    except Exception:
        return failure()


@node_route(['POST'])
def enqueue(request):
    user = lookup(request)
    if user is None: return reply(request, {'error': 'Unauthorized.'}, 401)
    # Validation before the source's persistence try/catch has empty 500 behavior.
    try:
        data = body(request)
        get = lambda key: property_of(data, key)
        key = name_value(get('inputVideoKey'))
        if not key: return reply(request, {'error': 'An input video is required.'}, 400)
        encoder = get('encoder') if get('encoder') in ('vits', 'vitb', 'vitl') else 'vitb'
        name = cut(get('originalName'), 200) or ''
        now = now_ms()
        identifier = uuid.uuid4()
        result = dict(id=str(identifier), kind='depth', status='queued', prompt=f'Depth map: {name}' if name else 'Depth map',
            model='Depth Anything (Local)', aspectRatio='16:9', resolution=encoder,
            trackCharacters=get('trackCharacters') is True, referenceVideos=[key], userId=str(user.id),
            costCents=0, createdAt=now, updatedAt=now)
        for field in ('projectId', 'folderId'):
            if truthy(get(field)): result[field] = get(field)
    except Exception:
        return failure()
    try:
        with transaction.atomic():
            Generation.objects.create(id=identifier, kind='depth', status='queued', prompt=result['prompt'], model=result['model'],
                aspect_ratio='16:9', resolution=encoder, track_characters=result['trackCharacters'], reference_videos=[key],
                project_id=result.get('projectId'), folder_id=result.get('folderId'), user_id=user.id, cost_cents=0, created_at=now, updated_at=now)
            assign_generation_naming(identifier, result.get('folderId'), result.get('projectId'), now)
        log_activity(user.id, 'generate', {'id': str(identifier), 'kind': 'depth', 'model': result['model'], 'costCents': 0})
        return reply(request, result)
    except Exception:
        return reply(request, {'error': 'Failed to save the generation request.'}, 500)


@node_route(['GET'])
def generation_status(request):
    if lookup(request) is None: return reply(request, {'error': 'Unauthorized.'}, 401)
    identifiers = request.query_params.getlist('id')
    identifier = identifiers[0] if identifiers else None
    if not identifier: return reply(request, {'error': 'id is required.'}, 400)
    try:
        row = Generation.objects.filter(pk=identifier, kind='depth').first()
        return reply(request, generation_item(row)) if row else reply(request, {'error': 'Not found.'}, 404)
    except Exception:
        return failure()
