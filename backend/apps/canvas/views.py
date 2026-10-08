from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .models import CanvasBoard


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def board_metadata_reads(request):
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    values = request.query_params.getlist('projectId')
    project = values[0] if values else None
    if not project:
        return with_renewal(request, Response({'error': 'projectId required.'}, status=400))
    # The switcher must never load the potentially 2 MB graph blob.
    rows = CanvasBoard.objects.filter(project_id=project).values(
        'id', 'project_id', 'name', 'created_by', 'created_at', 'updated_at')
    response = Response({'boards': [{'id': str(row['id']), 'projectId': str(row['project_id']),
        'name': row['name'], 'createdBy': str(row['created_by']) if row['created_by'] else None,
        'createdAt': row['created_at'], 'updatedAt': row['updated_at']} for row in rows]})
    return with_renewal(request, response)


def with_renewal(request, response):
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
