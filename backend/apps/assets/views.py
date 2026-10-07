from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .models import Asset


def serialize(asset):
    result = {'id': str(asset.id), 'kind': asset.kind, 'name': asset.name,
              'slug': asset.slug, 'images': asset.images if asset.images is not None else [],
              'createdAt': asset.created_at, 'updatedAt': asset.updated_at}
    # Current Node omits undefined fields, rather than emitting JSON null.
    if asset.description is not None:
        result['description'] = asset.description
    if asset.project_id is not None:
        result['projectId'] = str(asset.project_id)
    return result


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def asset_reads(request):
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    project_values = request.query_params.getlist('projectId')
    project = project_values[0] if project_values else None
    query = Asset.objects.all()
    if project:
        query = query.filter(project_id=project)
    response = Response({'assets': [serialize(asset) for asset in query.order_by('-created_at')]})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
                            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
