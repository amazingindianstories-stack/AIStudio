from django.db.models import Q
from .models import Generation
from .serialization import generation_item


def read_generation_updates(since, limit=100):
    rows = Generation.objects.exclude(kind='audio').filter(
        Q(status__in=['queued', 'running']) | Q(updated_at__gt=since)
    ).order_by('-updated_at')[:limit]
    return [generation_item(row) for row in rows]
