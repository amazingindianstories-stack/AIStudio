"""Stable names and monotonic namespace counters, in the caller's transaction."""
from django.conf import settings
from django.db import connection, transaction
from apps.library.models import GenerationNaming
from .idempotency import now_ms

NAME_NAMESPACE = 'name:'

GENERATION_LIBRARY_METADATA = frozenset({
    'project_id', 'folder_id', 'location_version', 'permanent_name', 'name_owner_id', 'legacy_name_duplicate',
    'is_favorite', 'favorited_at', 'flagged', 'flagged_at', 'flag_reason', 'updated_at',
})


def same_execution_identity(current, expected, *, ignored=()):
    """Fence all execution fields while allowing library edits during paid I/O.

    New model fields are protected by default. Callers may additionally allow
    their own heartbeat or already-acknowledged completion fields to change.
    """
    excluded = GENERATION_LIBRARY_METADATA.union(ignored)
    return all(getattr(current, field.attname) == getattr(expected, field.attname)
               for field in current._meta.concrete_fields if field.attname not in excluded)


def namespace_for(folder_id=None, project_id=None):
    return f'folder:{folder_id}' if folder_id else (f'project_unsorted:{project_id}' if project_id else 'global_unsorted')


def private_namespace(namespace, now=None):
    """Green workers allocate in a private namespace (VEEVEE_NAMING_PREFIX, validated in settings), seeded once
    from the canonical counter so their filenames continue its sequence without advancing it."""
    private = settings.VEEVEE_NAMING_PREFIX + namespace
    with connection.cursor() as cursor:
        cursor.execute('SELECT next_sequence FROM naming_counters WHERE namespace=%s', [namespace])
        row = cursor.fetchone()
        seed = max(1, int(row[0])) if row else 1
        cursor.execute('INSERT INTO naming_counters(namespace,next_sequence,updated_at) VALUES(%s,%s,%s) '
                       'ON CONFLICT(namespace) DO NOTHING', [private, seed, now_ms() if now is None else now])
    return private


def allocate_next_sequence(namespace, count=1, now=None):
    if settings.VEEVEE_RUNTIME_COMPONENT in ('generation', 'export', 'scheduler') and settings.VEEVEE_NAMING_PREFIX:
        namespace = private_namespace(namespace, now)
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
    generation = Generation.objects.select_for_update().get(pk=generation_id)
    if (not generation.permanent_name and generation.kind == 'video' and generation.model == 'Seedance 2.5'
            and generation.draft_mode is False and generation.source_generation_id and generation.draft_task_id):
        draft = Generation.objects.select_for_update().filter(pk=generation.source_generation_id,
            kind='video', model='Seedance 2.5', draft_mode=True, task_id=generation.draft_task_id).first()
        if draft:
            # Finalizing is the point at which even an Unsorted draft needs a
            # durable name. All subsequent finals reuse this single reservation.
            assign_generation_naming(draft.id, draft.folder_id, draft.project_id, now)
            draft.refresh_from_db()
            freeze_names([draft], now)
            draft.refresh_from_db()
            Generation.objects.filter(pk=generation.id).update(permanent_name=draft.permanent_name,
                name_owner_id=draft.name_owner_id, legacy_name_duplicate=draft.legacy_name_duplicate)
            generation.refresh_from_db()
    existing = GenerationNaming.objects.filter(generation_id=generation_id).first()
    if existing:
        if folder_id and not generation.permanent_name:
            freeze_names([generation], now)
        return assignment_json(existing)
    now = now_ms() if now is None else now
    namespace = namespace_for(folder_id, project_id)
    row = GenerationNaming.objects.create(generation_id=generation_id, namespace=namespace,
        sequence=allocate_next_sequence(namespace, now=now), assigned_at=now)
    if folder_id:
        freeze_names([generation], now)
    return assignment_json(row)


def names_in_use(names):
    with connection.cursor() as cursor:
        cursor.execute('''SELECT lower(permanent_name) FROM generation_name_owners
            WHERE permanent_name IS NOT NULL AND lower(permanent_name) = ANY(%s)''', [[name.lower() for name in names]])
        return {row[0] for row in cursor.fetchall()}


def freeze_names(generations, now=None):
    from apps.generation.models import Generation
    from apps.library.filenames import (MAX_EXTENSION_BYTES, bound_filename, format_serial, name_prefix,
                                        naming_rows, resolve_extension)
    generations = sorted((row for row in generations if not row.permanent_name), key=lambda row: str(row.id))
    prefixes = {identifier: name_prefix(ancestry, namespace)
                for identifier, _, _, namespace, _, _, ancestry in naming_rows([row.id for row in generations])}
    groups = {}
    for row in generations:
        prefix = prefixes[str(row.id)]
        groups.setdefault(prefix.lower(), []).append((row, prefix))
    for key in sorted(groups):
        pending = groups[key]
        while pending:
            start = allocate_next_sequence(NAME_NAMESPACE + key, len(pending), now)
            for offset, (row, prefix) in enumerate(pending):
                row.permanent_name = bound_filename(prefix, format_serial(start + offset), resolve_extension(row.kind, row.url),
                    0 if row.url else MAX_EXTENSION_BYTES).rsplit('.', 1)[0]
            taken = names_in_use([row.permanent_name for row, _ in pending])
            pending = [(row, prefix) for row, prefix in pending if row.permanent_name.lower() in taken]
    Generation.objects.bulk_update(generations, ['permanent_name'], batch_size=1000)


def reassign_naming_for_move(rows, target_namespace, now):
    rows = sorted(rows, key=lambda r: str(r.id))
    existing = {str(r.generation_id): r for r in GenerationNaming.objects.filter(generation_id__in=[r.id for r in rows])}
    changed = [r for r in rows if not r.permanent_name and (str(r.id) not in existing or existing[str(r.id)].namespace != target_namespace)]
    assignments = []
    if changed:
        start = allocate_next_sequence(target_namespace, len(changed), now)
        for offset, row in enumerate(changed):
            naming, _ = GenerationNaming.objects.update_or_create(generation_id=row.id,
                defaults={'namespace': target_namespace, 'sequence': start + offset, 'assigned_at': now})
            assignments.append(assignment_json(naming))
    if target_namespace.startswith('folder:'):
        from apps.generation.models import Generation
        freeze_names(Generation.objects.filter(pk__in=[r.id for r in rows], permanent_name__isnull=True), now)
    return {'reallocatedCount': len(changed), 'preservedCount': len(rows) - len(changed), 'assignments': assignments}
