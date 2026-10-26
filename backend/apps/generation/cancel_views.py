from django.core.exceptions import ValidationError
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response

from apps.authentication.session import lookup
from apps.common.responses import renew_session
from .serialization import generation_item
from .services.cancellation import CancelError, cancel_generation


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def cancel(request):
    actor = lookup(request)
    if actor is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    identifier = request.data.get('id') if isinstance(request.data, dict) else None
    if not identifier:
        return Response({'error': 'Missing generation id.'}, status=400)
    try:
        item, message = cancel_generation(identifier, actor)
    except (ValidationError, ValueError):
        return Response({'error': 'Invalid generation id.'}, status=400)
    except CancelError as error:
        return Response({'error': str(error)}, status=error.status)
    response = Response({'item': generation_item(item), 'message': message},
        status=200 if item.status == 'cancelled' else 202 if item.cancellation_state in ('requested', 'uncertain') else 409)
    response['Cache-Control'] = 'no-store'
    return renew_session(request, response)
