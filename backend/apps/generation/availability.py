"""Which models a new job may use right now.

One answer for the composer's pickers (``availability`` on GET /api/auth/me) and the paid guard's enqueue refusals
(apps/generation/services/paid_guard.py calls ``switched_on``), so a picker never offers a model that enqueue refuses.
It reports availability only: never credentials, hosts, prices or other configuration.
"""
from django.conf import settings

from .model_registry import MODEL_REGISTRY

# The backend switch (a Railway service variable on the API and the generation worker) that admits new jobs for each
# provider. A provider with no entry has no switch.
SWITCHES = {'kling': 'VEEVEE_KLING', 'omni': 'VEEVEE_GEMINI_OMNI', 'magnific': 'VEEVEE_MAGNIFIC_UPSCALE'}


def switched_on(provider):
    """False only while the provider's switch is off."""
    switch = SWITCHES.get(provider)
    return switch is None or getattr(settings, switch, False) is True


def available(model):
    """A registry entry new jobs may use: offered, not retired, and its provider switched on."""
    return model.get('offered') is True and not model.get('retiredFor') and switched_on(model.get('provider'))


def availability():
    """The registry ids of every model new jobs may use, in registry order."""
    return {'models': [model['id'] for model in MODEL_REGISTRY if available(model)]}
