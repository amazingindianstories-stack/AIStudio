from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .models import Generation
from .services.admission import queue_position


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def queue_status(request):
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    identifiers = request.query_params.getlist('id')
    identifier = identifiers[0] if identifiers else None
    if not identifier:
        return Response({'error': 'Missing id'}, status=400)
    try:
        item = Generation.objects.filter(pk=identifier).first()
        if item is None:
            return Response({'error': 'Not found'}, status=404)
        if str(item.user_id) != str(user.id) and user.role != 'admin':
            return Response({'error': 'FORBIDDEN'}, status=403)
        value = queue_position(identifier)
        if value is None:
            return Response({'error': 'Not found'}, status=404)
        return Response(value)
    except Exception:
        return Response({'error': 'Internal server error'}, status=500)
