import hmac
import uuid
from datetime import datetime, timezone
from django.conf import settings
from django.core.exceptions import ValidationError
from django.http import HttpResponse, StreamingHttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.responses import renew_session
from apps.library.services.idempotency import now_ms
from apps.library.views import body_or_empty
from apps.media.storage import get_storage, attachment_disposition, MediaNotFoundError
from .models import MediaExport, MediaExportItem
from . import services


def authenticated(request):
    return lookup(request)


def denied():
    return Response({'error': 'UNAUTHENTICATED'}, status=401)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def create(request):
    user = authenticated(request)
    if user is None:
        return denied()
    return renew_session(request, Response(services.create_export(user.id), status=201))


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def status(request, id):
    user = authenticated(request)
    if user is None:
        return denied()
    row = services.owned_export(id, user.id)
    if row is None:
        return Response({'error': 'NOT_FOUND'}, status=404)
    return renew_session(request, Response({'id': str(row.id), 'status': row.status, 'totalItems': row.total_items,
        'processedItems': row.processed_items, 'skippedItems': row.skipped_items, 'warnings': row.warnings,
        'error': ('Export failed.' if row.status == 'failed' else 'Export encountered an error; retry is pending.') if row.error else None,
        'expiresAt': row.expires_at,
        'complete': row.status == 'ready' and row.total_items > 0 and row.skipped_items == 0,
        'retryable': row.status == 'failed' and row.total_items > 0,
        'nextAction': 'retry_export' if row.status == 'failed' else 'wait' if row.status in ('queued', 'running') else 'download' if row.status == 'ready' else 'finalize'}))


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def items(request, id):
    user = authenticated(request)
    if user is None:
        return denied()
    body = body_or_empty(request)
    try:
        result = services.append_items(id, user.id, body.get('ids') if isinstance(body.get('ids'), list) else [])
        return renew_session(request, Response(result))
    except services.ExportError as exc:
        code = str(exc)
        return renew_session(request, Response({'error': code}, status={'EXPORT_NOT_FOUND': 404, 'EXPORT_NOT_DRAFT': 409}.get(code, 400)))
    except (ValueError, ValidationError):
        return Response({'error': 'INVALID_EXPORT_ITEMS'}, status=400)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def finalize(request, id):
    user = authenticated(request)
    if user is None:
        return denied()
    try:
        row = services.finalize_export(id, user.id)
        return renew_session(request, Response({'id': str(row.id), 'status': row.status}))
    except Exception as exc:
        message = ('Some selected assets no longer have valid folder or source metadata. Create a new export after refreshing your selection.'
            if str(exc) == 'EXPORT_MANIFEST_INVALID' else 'Export cannot be queued.')
        return renew_session(request, Response({'error': message}, status=409))


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def download(request, id):
    user = authenticated(request)
    if user is None:
        return denied()
    row = services.owned_export(id, user.id)
    if row is None:
        return Response({'error': 'NOT_FOUND'}, status=404)
    if row.status != 'ready' or not row.output_key:
        return Response({'error': 'NOT_READY'}, status=409)
    if not row.expires_at or row.expires_at <= now_ms():
        return Response({'error': 'EXPIRED'}, status=410)
    filename = 'Veevee_Assets_' + datetime.fromtimestamp(row.created_at / 1000, timezone.utc).strftime('%Y-%m-%d') + '.zip'
    storage = get_storage()
    try:
        signed = storage.signed_export_download_url(row.output_key, filename)
        if signed:
            response = HttpResponse(status=307)
            response['Location'] = signed
        else:
            media = storage.open(row.output_key)
            response = StreamingHttpResponse(media.stream, content_type='application/zip')
            response['Content-Length'] = str(media.content_length)
            response['Content-Disposition'] = attachment_disposition(filename)
            response['X-Content-Type-Options'] = 'nosniff'
    except MediaNotFoundError:
        return Response({'error': 'ARCHIVE_UNAVAILABLE', 'message': 'Archive is unavailable. Create a new export.'}, status=404)
    except Exception:
        return Response({'error': 'DOWNLOAD_UNAVAILABLE', 'message': 'Download is temporarily unavailable. Retry the download.'}, status=503)
    response['Cache-Control'] = 'private, no-store'
    return renew_session(request, response)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def worker_access(request):
    expected = getattr(settings, 'EXPORT_WORKER_SECRET', '')
    actual = request.headers.get('x-export-worker-secret', '')
    if not expected or not actual or not hmac.compare_digest(expected.encode(), actual.encode()):
        return Response({'error': 'FORBIDDEN'}, status=403)
    body = body_or_empty(request)
    try:
        job = MediaExport.objects.filter(pk=body.get('exportId'), status='running', lease_owner=body.get('owner')).first()
    except (ValidationError, ValueError):
        job = None
    if not job or not job.lease_until or job.lease_until <= now_ms():
        return Response({'error': 'LEASE_LOST'}, status=409)
    if body.get('action') == 'upload':
        # Each issued upload capability gets a separate object. A still-valid
        # obsolete resumable session cannot overwrite another attempt/winner.
        key = f'exports/{job.user_id}/{job.id}/{job.attempt_count}-legacy-{uuid.uuid4().hex}.zip'
        return Response({'key': key, 'url': get_storage().create_resumable_upload_session(key)})
    if body.get('action') == 'source':
        try:
            item = MediaExportItem.objects.filter(export=job, generation_id=body.get('generationId')).first()
        except (ValidationError, ValueError):
            item = None
        if item is None:
            return Response({'error': 'ITEM_NOT_FOUND'}, status=404)
        return Response({'url': get_storage().signed_read_url(item.source_key, 900)})
    return Response({'error': 'INVALID_ACTION'}, status=400)
