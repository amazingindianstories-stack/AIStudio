"""Stable names and monotonic namespace counters, in the caller's transaction."""
from django.db import connection, transaction
from apps.library.models import GenerationNaming
from .idempotency import now_ms


def namespace_for(folder_id=None, project_id=None):
    return f'folder:{folder_id}' if folder_id else (f'project_unsorted:{project_id}' if project_id else 'global_unsorted')


def allocate_next_sequence(namespace, count=1, now=None):
    count = max(1, int(count or 1))
    with connection.cursor() as cursor:
        cursor.execute('''INSERT INTO naming_counters(namespace,next_sequence,updated_at)
            VALUES (%s,%s,%s) ON CONFLICT(namespace) DO UPDATE SET
            next_sequence=naming_counters.next_sequence+%s,updated_at=EXCLUDED.updated_at
            RETURNING next_sequence-%s''', [namespace, count + 1, now_ms() if now is None else now, count, count])
        sequence = cursor.fetchone()[0]
    if sequence <= 0 or sequence > 9007199254740991:
        raise ValueError(f'Failed to allocate sequence for namespace {namespace}')
    return sequence


def assignment_json(row):
    return {'generationId': str(row.generation_id), 'namespace': row.namespace,
            'sequence': row.sequence, 'assignedAt': row.assigned_at}


@transaction.atomic
def assign_generation_naming(generation_id, folder_id=None, project_id=None, now=None):
    # The generation lock makes explicit assignment and retries single-winner.
    from apps.generation.models import Generation
    Generation.objects.select_for_update().get(pk=generation_id)
    existing = GenerationNaming.objects.filter(generation_id=generation_id).first()
    if existing:
        return assignment_json(existing)
    now = now_ms() if now is None else now
    namespace = namespace_for(folder_id, project_id)
    row = GenerationNaming.objects.create(generation_id=generation_id, namespace=namespace,
        sequence=allocate_next_sequence(namespace, now=now), assigned_at=now)
    return assignment_json(row)


def reassign_naming_for_move(rows, target_namespace, now):
    rows = sorted(rows, key=lambda r: str(r.id))
    existing = {str(r.generation_id): r for r in GenerationNaming.objects.filter(generation_id__in=[r.id for r in rows])}
    changed = [r for r in rows if str(r.id) not in existing or existing[str(r.id)].namespace != target_namespace]
    assignments = []
    if changed:
        start = allocate_next_sequence(target_namespace, len(changed), now)
        for offset, row in enumerate(changed):
            naming, _ = GenerationNaming.objects.update_or_create(generation_id=row.id,
                defaults={'namespace': target_namespace, 'sequence': start + offset, 'assigned_at': now})
            assignments.append(assignment_json(naming))
    return {'reallocatedCount': len(changed), 'preservedCount': len(rows) - len(changed), 'assignments': assignments}
