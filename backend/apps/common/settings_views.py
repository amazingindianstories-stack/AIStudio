from rest_framework.decorators import api_view
from rest_framework.response import Response

from .limits import read_effective_limits


@api_view(["GET"])
def settings_view(request):
    return Response(read_effective_limits(request.user.id))
