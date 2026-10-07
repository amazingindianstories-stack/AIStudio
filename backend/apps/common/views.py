from django.db import connection, DatabaseError
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response

@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def health(request):
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
            ready = cursor.fetchone() == (1,)
    except DatabaseError:
        ready = False
    response = Response({'ok': ready, 'django': 'ready', 'database': 'ready' if ready else 'unavailable'}, status=200 if ready else 503)
    response['Cache-Control'] = 'no-store'
    return response
