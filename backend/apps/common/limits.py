import time

from .models import AppSetting, UserLimit


DEFINITIONS = {
    "maxPromptLength": {"label": "Max prompt length", "default": 30000, "min": 1},
    "maxConcurrentJobs": {"label": "Max concurrent jobs", "default": 1, "min": 1},
}


def definition(key):
    return DEFINITIONS.get(key)


def parse_value(value, item):
    try:
        parsed = int(value)
        return parsed if parsed >= item["min"] else item["default"]
    except (TypeError, ValueError):
        return item["default"]


def read_all_global_limits():
    rows = {row.key: row.value for row in AppSetting.objects.filter(key__in=DEFINITIONS)}
    return {key: parse_value(rows.get(key), item) for key, item in DEFINITIONS.items()}


def read_user_limits(user_id):
    result = {}
    for row in UserLimit.objects.filter(user_id=user_id):
        if row.key in DEFINITIONS:
            result[row.key] = parse_value(row.value, DEFINITIONS[row.key])
    return result


def read_all_user_limits():
    result = {}
    for row in UserLimit.objects.all():
        if row.key in DEFINITIONS:
            result.setdefault(str(row.user_id), {})[row.key] = parse_value(row.value, DEFINITIONS[row.key])
    return result


def read_effective_limits(user_id):
    values = read_all_global_limits()
    values.update(read_user_limits(user_id))
    return values


def update_global_limit(key, value):
    AppSetting.objects.update_or_create(
        key=key, defaults={"value": str(value), "updated_at": int(time.time() * 1000)}
    )


def update_user_limit(user_id, key, value):
    lookup = {"user_id": user_id, "key": key}
    if value is None:
        UserLimit.objects.filter(**lookup).delete()
    else:
        UserLimit.objects.update_or_create(
            **lookup, defaults={"value": str(value), "updated_at": int(time.time() * 1000)}
        )
