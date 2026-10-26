"""Explicit, admin-only subtree naming with a checked confirmation preview."""
import re
from collections import defaultdict
from django.db import connection, OperationalError
from apps.authentication.models import User
from apps.generation.models import Generation
from apps.library.models import Folder, NamingCounter
from apps.library.filenames import MAX_EXTENSION_BYTES, bound_filename, format_serial, name_prefix, resolve_extension
from . import folder_engine
from .idempotency import OrganizationError, execute, fingerprint, now_ms
from .naming import NAME_NAMESPACE, allocate_next_sequence, names_in_use


def require_admin(actor_id):
    if not actor_id or not User.objects.filter(pk=actor_id, role='admin', is_active=True).exists():
        raise OrganizationError('FORBIDDEN', 'Only admins can rename generations.', 403)


def stem_for(row, folders):
    ancestry, seen, folder = [], set(), folders.get(row.folder_id)
    while folder and folder.id not in seen:
        seen.add(folder.id)
        ancestry.insert(0, {'name': folder.name})
        folder = folders.get(folder.parent_id)
    return name_prefix(ancestry, f'folder:{row.folder_id}' if row.folder_id else 'global_unsorted')


def ancestry_folders(rows):
    folders, pending = {}, {row.folder_id for row in rows if row.folder_id}
    while pending:
        found = list(Folder.objects.filter(pk__in=pending))
        pending = set()
        for folder in found:
            folders[folder.id] = folder
            if folder.parent_id and folder.parent_id not in folders:
                pending.add(folder.parent_id)
    return folders


def matches_stem(row, stem):
    sequence = format_serial(current_sequence(row))
    # Names assigned before a master existed reserve room for every extension.
    return any(row.permanent_name == bound_filename(stem, sequence, resolve_extension(row.kind, row.url), reserve).rsplit('.', 1)[0]
               for reserve in (0, MAX_EXTENSION_BYTES))


def stem_name(row, stem, sequence):
    return bound_filename(stem, format_serial(sequence), resolve_extension(row.kind, row.url),
        MAX_EXTENSION_BYTES).rsplit('.', 1)[0]


def current_sequence(row):
    match = re.search(r'_(\d+)$', row.permanent_name or '')
    return int(match[1]) if match else 1


def plan(folder_id, *, lock=False):
    root = folder_engine.locked_folder(folder_id)
    subtree = {root.id, *(row.id for row in folder_engine.descendants(root.id))}
    selected_query = Generation.objects.filter(folder_id__in=subtree).order_by('id')
    if lock:
        selected_query = selected_query.select_for_update(nowait=True)
    selected = list(selected_query)
    owners = {row.name_owner_id for row in selected if row.name_owner_id}
    if lock:
        # Final naming locks its draft before sharing the reservation. Fence
        # that point before reading membership, including finals filed elsewhere.
        list(Generation.objects.select_for_update(nowait=True).filter(pk__in=owners).order_by('id'))
    query = Generation.objects.filter(name_owner_id__in=owners).order_by('id')
    if lock:
        query = query.select_for_update(nowait=True)
    members = list(query)
    folders = ancestry_folders(members)
    groups = defaultdict(list)
    for row in members:
        groups[row.name_owner_id].append(row)
    eligible, skipped, unchanged = [], 0, 0
    for owner, rows in groups.items():
        stems = {stem_for(row, folders) for row in rows}
        inside = [row for row in rows if row.folder_id in subtree]
        if any(row.folder_id not in subtree for row in rows) or len(stems) != 1:
            skipped += len(inside)
            continue
        stem = stems.pop()
        if all(matches_stem(row, stem) for row in rows):
            unchanged += len(rows)
            continue
        representative = min(rows, key=lambda row: (row.id != owner, row.created_at, str(row.id)))
        eligible.append((owner, rows, stem, representative))
    eligible.sort(key=lambda item: (item[2].lower(), current_sequence(item[3]), item[3].created_at, str(item[3].id)))
    counters = dict(NamingCounter.objects.filter(namespace__in={NAME_NAMESPACE + item[2].lower() for item in eligible})
                    .values_list('namespace', 'next_sequence'))
    reserved = set()
    changes = []
    for owner, rows, stem, representative in eligible:
        namespace = NAME_NAMESPACE + stem.lower()
        sequence = counters.get(namespace, 1)
        name = stem_name(representative, stem, sequence)
        while name.lower() in reserved or names_in_use([name]):
            sequence += 1
            name = stem_name(representative, stem, sequence)
        reserved.add(name.lower())
        counters[namespace] = sequence + 1
        changes.append({'owner': str(owner), 'representative': str(representative.id), 'ids': sorted(str(row.id) for row in rows),
            'oldNames': [row.permanent_name for row in rows], 'newName': name,
            'namespace': namespace, 'sequence': sequence})
    result = {'renamedCount': sum(len(change['ids']) for change in changes), 'skippedCount': skipped,
        'unchangedCount': unchanged, 'example': None}
    if changes:
        result['example'] = {'oldName': changes[0]['oldNames'][0], 'newName': changes[0]['newName']}
    result['previewToken'] = fingerprint({'folderId': str(folder_id), 'changes': changes, 'summary': result})
    return result, changes


def preview_folder_names(*, folder_id, actor_id):
    require_admin(actor_id)
    return execute('preview_folder_names', {}, lambda: plan(folder_id)[0])


def rename_folder_generations(*, folder_id, actor_id, preview_token, idempotency_key=None):
    # Authorization precedes both mutations and idempotent replay.
    require_admin(actor_id)
    def mutate():
        try:
            result, changes = plan(folder_id, lock=True)
        except OperationalError as error:
            if getattr(error.__cause__, 'sqlstate', None) != '55P03':
                raise
            raise OrganizationError('PREVIEW_CHANGED', 'A generation is being updated. Review a fresh preview and try again.', 409) from error
        if not preview_token or preview_token != result['previewToken']:
            raise OrganizationError('PREVIEW_CHANGED', 'Folder contents or names changed. Review a fresh preview and try again.', 409)
        now = now_ms()
        for change in changes:
            # Allocate through the existing atomic library-wide counter. Other
            # folders/projects may consume the same namespace after preview.
            sequence = allocate_next_sequence(change['namespace'], now=now)
            row = Generation.objects.get(pk=change['representative'])
            # Skip reserved gaps using exactly the existing reservation rules.
            stem = stem_for(row, ancestry_folders([row]))
            candidate = stem_name(row, stem, sequence)
            while names_in_use([candidate]):
                sequence = allocate_next_sequence(change['namespace'], now=now)
                candidate = stem_name(row, stem, sequence)
            if candidate != change['newName']:
                raise OrganizationError('PREVIEW_CHANGED', 'Name allocation changed. Review a fresh preview and try again.', 409)
            with connection.cursor() as cursor:
                cursor.execute('SELECT rename_generation_lineage(%s::uuid,%s,%s::uuid,%s)',
                    [change['owner'], candidate, actor_id, now])
        result.pop('previewToken')
        return result
    return execute('rename_folder_generations', {'folderId': str(folder_id), 'previewToken': preview_token},
        mutate, actor_id=actor_id, idempotency_key=idempotency_key)
