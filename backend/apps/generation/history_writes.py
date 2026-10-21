"""History metadata and explicit organization mutations.

Deleting a history row retains storage objects, exactly as the current contract:
references and finalized exports can still point at the immutable media master.
"""
from django.core.exceptions import ValidationError
from django.db import DataError, transaction
from django.http import HttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.responses import log_activity, renew_session
from apps.library.models import Folder
from apps.library.services.folder_engine import move_generations
from apps.library.services.idempotency import MISSING, OrganizationError, now_ms
from apps.library.views import body_or_empty
from .models import Generation
from .serialization import generation_item


def unhandled_contract_error():
    # The legacy single-item handler has no catch around organization or UUID
    # failures. Preserve its empty 500 envelope without leaking DB diagnostics.
    response = HttpResponse(b'', status=500)
    del response['Content-Type']
    return response


def patch_metadata(body):
    identifier = body['id']
    if type(body.get('isFavorite')) is bool:
        now = now_ms()
        changed = Generation.objects.filter(pk=identifier).update(is_favorite=body['isFavorite'],
            favorited_at=now if body['isFavorite'] else None, updated_at=now)
    elif type(body.get('flagged')) is bool:
        now = now_ms()
        changed = Generation.objects.filter(pk=identifier).update(flagged=body['flagged'],
            flagged_at=now if body['flagged'] else None,
            flag_reason=body.get('flagReason') if body['flagged'] else None, updated_at=now)
    else:
        project_id, folder_id = body.get('projectId'), body.get('folderId')
        if folder_id and project_id:
            folder = Folder.objects.filter(pk=folder_id).first()
            if not folder or str(folder.project_id) != project_id:
                raise OrganizationError('PROJECT_MISMATCH', 'Project mismatch: folder belongs to a different project.')
        destination = ({'type': 'folder', 'folderId': folder_id} if folder_id else
            {'type': 'project_unsorted', 'projectId': project_id} if project_id else {'type': 'global_unsorted'})
        move_generations(ids=[identifier], destination=destination)
        changed = True
    row = Generation.objects.filter(pk=identifier).first() if changed else None
    return generation_item(row) if row else None


def history_mutation(request, user):
    try:
        if request.method == 'PATCH':
            body = body_or_empty(request)
            if not body.get('id'):
                return Response({'error': 'Missing id.'}, status=400)
            if type(body.get('isFavorite')) is not bool and type(body.get('flagged')) is not bool and user.role != 'admin':
                return Response({'error': 'Only admins can move generations.'}, status=403)
            with transaction.atomic():
                result = patch_metadata(body)
            return Response(result) if result else Response({'error': 'Not found.'}, status=404)
        if user.role != 'admin':
            return Response({'error': 'Only admins can delete generations.'}, status=403)
        identifier = request.query_params.getlist('id')
        identifier = identifier[0] if identifier else None
        if not identifier:
            return Response({'error': 'Missing id.'}, status=400)
        with transaction.atomic():
            item = Generation.objects.select_for_update().filter(pk=identifier).first()
            if not item:
                return Response({'error': 'Not found.'}, status=404)
            # History deletion is not a provider cancellation/reconciliation
            # protocol. Keep active or ambiguous paid-work evidence durable.
            if item.status in ('queued','running','pending') or item.provider_status in (
                    'SUBMISSION_PENDING','SUBMISSION_UNCERTAIN'):
                return Response({'error':'GENERATION_REQUIRES_RECONCILIATION',
                    'message':'Active or uncertain generation work must finish or be reconciled before deletion.'},status=409)
            detail = {'id': identifier, 'kind': item.kind, 'model': item.model,
                'prompt': item.prompt.encode('utf-16-le', errors='surrogatepass')[:240].decode('utf-16-le', errors='surrogatepass'),
                'ownerId': str(item.user_id) if item.user_id else None}
            item.delete()
            log_activity(user.id, 'delete', detail)
        return Response({'ok': True})
    except (ValidationError, DataError, OrganizationError, ValueError):
        return unhandled_contract_error()


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def history_move(request):
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    if user.role != 'admin':
        return Response({'error': 'Only admins can move generations.'}, status=403)
    body = body_or_empty(request)
    ids, destination = body.get('ids'), body.get('destination')
    if not isinstance(ids, list) or not ids:
        return Response({'error': 'At least one generation ID is required.'}, status=400)
    if not isinstance(destination, (dict, list)):
        return Response({'error': 'Destination descriptor is required.'}, status=400)
    key = body.get('idempotencyKey') or request.headers.get('x-idempotency-key') or request.headers.get('idempotency-key')
    try:
        result = move_generations(ids=ids, destination=destination,
            expected_versions=body.get('expectedVersions', MISSING),
            actor_id=str(user.id), idempotency_key=key)
        return renew_session(request, Response({'success': True, **result}))
    except OrganizationError as exc:
        return renew_session(request, Response({'error': str(exc), 'code': exc.code}, status=exc.status))
    except Exception:
        return renew_session(request, Response({'error': 'Failed to move generations.'}, status=500))
