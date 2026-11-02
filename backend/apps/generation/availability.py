"""Which models a new job may use right now.

One answer for the composer's pickers (``availability`` on GET /api/auth/me), the submission refusals
(apps/generation/services/enqueue.py ``refuse_unavailable``) and the paid guard's quotes (``switched_on``), so a picker
offers exactly the models submission accepts.
It reports availability only: never credentials, hosts, prices or other configuration.
"""
from django.conf import settings

from .model_registry import MODEL_REGISTRY

# The backend switch (a Railway service variable on the API and the generation worker) that admits new jobs for each
# provider. A provider with no entry has no switch.
SWITCHES = {'omnihuman': 'VEEVEE_OMNIHUMAN', 'kling': 'VEEVEE_KLING', 'omni': 'VEEVEE_GEMINI_OMNI', 'magnific': 'VEEVEE_MAGNIFIC_UPSCALE'}


def switched_on(provider):
    """False only while the provider's switch is off."""
    switch = SWITCHES.get(provider)
    return switch is None or getattr(settings, switch, False) is True


def admin_blocked(model, blocked=None):
    """True when a workspace admin blocked the model or its provider (apps/admin_dashboard/workspace.py)."""
    if blocked is None:
        from apps.admin_dashboard.workspace import ai_blocked
        blocked = ai_blocked()
    return model.get('id') in blocked['models'] or model.get('provider') in blocked['providers']


def available(model, blocked=None):
    """A registry entry new jobs may use: offered, not retired, its provider switched on and not blocked by an admin."""
    return (model.get('offered') is True and not model.get('retiredFor') and switched_on(model.get('provider'))
            and not admin_blocked(model, blocked))


def availability():
    """The registry ids of every model new jobs may use, in registry order."""
    from apps.admin_dashboard.workspace import ai_blocked
    blocked = ai_blocked()
    return {'models': [model['id'] for model in MODEL_REGISTRY if available(model, blocked)]}
