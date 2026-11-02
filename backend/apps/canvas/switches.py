"""Admin feature switches for board features: an admin turns a feature off for everyone, or for one user.

A switch is an admin limit that is 1 (on, the default) or 0 (off), read at call time: the global value lives in
``AppSetting`` and a per-user override in ``UserLimit``, exactly like the other admin limits. Today the board
feature with a switch is Create with AI (``boardAiEnabled``); a new switch is one more entry in LIMITS."""
AI = 'boardAiEnabled'


def enabled(user_id, key):
    from apps.admin_dashboard.models import AppSetting, UserLimit
    from apps.admin_dashboard.views import LIMITS, parse
    raw = UserLimit.objects.filter(user_id=user_id, key=key).values_list('value', flat=True).first()
    if raw is None:
        raw = AppSetting.objects.filter(key=key).values_list('value', flat=True).first()
    return parse(raw, LIMITS[key]) != 0
