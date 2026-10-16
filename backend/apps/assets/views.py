from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .models import Asset


def serialize(asset):
    result = {'id': str(asset.id), 'kind': asset.kind, 'name': asset.name,
              'slug': asset.slug, 'images': asset.images if asset.images is not None else [],
              'createdAt': asset.created_at, 'updatedAt': asset.updated_at}
    result['createdById'] = str(asset.created_by_id) if asset.created_by_id else None
    result['uploader'] = None
    if asset.created_by_id:
        from apps.authentication.models import User
        user = User.objects.filter(pk=asset.created_by_id).only('id', 'name', 'avatar_url', 'color').first()
        if user:
            result['uploader'] = {'id': str(user.id), 'name': user.name, 'avatarUrl': user.avatar_url, 'color': user.color}
    # Current Node omits undefined fields, rather than emitting JSON null.
    if asset.description is not None:
        result['description'] = asset.description
    if asset.project_id is not None:
        result['projectId'] = str(asset.project_id)
    return result


@api_view(['GET', 'POST', 'DELETE'])
@authentication_classes([])
@permission_classes([])
def asset_reads(request):
    actor = lookup(request)
    if actor is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    if request.method == 'POST':
        from .catalog import save_catalog_asset
        return save_catalog_asset(request, actor)
    if request.method == 'DELETE':
        from .catalog import delete_catalog_asset
        return delete_catalog_asset(request, actor)
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
