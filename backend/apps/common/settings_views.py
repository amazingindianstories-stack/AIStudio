from rest_framework.decorators import api_view
from rest_framework.response import Response

from .limits import read_effective_limits


@api_view(["GET"])
def settings_view(request):
    return Response(read_effective_limits(request.user.id))


@api_view(["GET"])
def pricing_view(request):
    """Authenticated composer estimates use configured rates, not client defaults."""
    from apps.generation.pricing_db import read_pricing
    response = Response({"pricing": read_pricing(), "basis": "estimated", "currency": "USD"})
    response["Cache-Control"] = "no-store"
    return response
