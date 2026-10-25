"""Portable, deterministic v3 archive paths frozen before a worker is queued."""
import hashlib
import re
import unicodedata
from collections import defaultdict
from apps.library.filenames import RESERVED

MAX_COMPONENT_BYTES = 255
MAX_PATH_BYTES = 4096
MAX_DEPTH = 32
MAX_ITEMS = 100_000


def folded(value):
    return unicodedata.normalize('NFC', value).casefold()


def safe_zip_member_path(value):
    if not isinstance(value, str) or not value or len(value.encode('utf-8')) > MAX_PATH_BYTES:
        raise ValueError('Unsafe export path.')
    parts = value.split('/')
    if len(parts) > MAX_DEPTH + 4:
        raise ValueError('Export folder hierarchy is too deep.')
    for part in parts:
        if (not part or part in ('.', '..') or part != part.strip(' .')
                or len(part.encode('utf-8')) > MAX_COMPONENT_BYTES
                or unicodedata.normalize('NFC', part) != part
                or any(unicodedata.category(c).startswith('C') or c in '\\:<>"|?*' for c in part)
                or unicodedata.normalize('NFKC', part.split('.')[0]).rstrip(' ').upper() in RESERVED):
            raise ValueError('Unsafe export path.')
    return value


def component(raw, fallback):
    raw = unicodedata.normalize('NFC', str(raw or ''))
    # Invisible spacing (no-break, zero-width, BOM) counts as space so edges trim cleanly.
    raw = ''.join(' ' if unicodedata.category(c) in ('Cf', 'Zs', 'Zl', 'Zp') else c for c in raw)
    raw = re.sub(' {2,}', ' ', raw)
    raw = ''.join('_' if unicodedata.category(c).startswith('C') or c in '/\\:<>"|?*' else c for c in raw).strip(' .')
    raw = raw if raw and raw not in ('.', '..') else fallback
    if unicodedata.normalize('NFKC', raw.split('.')[0]).rstrip(' ').upper() in RESERVED:
        raw = '_' + raw
    if len(raw.encode('utf-8')) > 180:
        suffix = '_' + hashlib.sha256(raw.encode('utf-8')).hexdigest()[:12]
        while len((raw + suffix).encode('utf-8')) > 180:
            raw = raw[:-1]
        raw = raw.rstrip(' .') + suffix
    return raw


def suffix(value, identifier):
    return value + '_' + hashlib.sha256(str(identifier).encode()).hexdigest()[:12]


def lineage_leaves(aliases, generations, paths, occupied):
    """Keep one draft lineage in its directory: the earliest final keeps the
    shared leaf, later finals take _2, _3 in creation order and the draft _draft."""
    rows = [generations[gid] for gid in aliases]
    owner = rows[0].name_owner_id
    if owner is None or any(row.name_owner_id != owner for row in rows):
        return False
    parent, leaf = paths[aliases[0]].rsplit('/', 1)
    stem, extension = leaf.rsplit('.', 1)
    finals = sorted((row for row in rows if row.id != owner), key=lambda row: (row.created_at, str(row.id)))
    leaves = {str(row.id): stem + ('_' + str(rank) if rank > 1 else '') for rank, row in enumerate(finals, 1)}
    leaves.update({str(row.id): stem + '_draft' for row in rows if row.id == owner})
    candidates = {gid: f'{parent}/{value}.{extension}' for gid, value in leaves.items()}
    try:
        for path in candidates.values():
            safe_zip_member_path(path)
    except ValueError:
        return False
    if any(folded(path) in occupied for gid, path in candidates.items() if folded(path) != folded(paths[gid])):
        return False
    paths.update(candidates)
    occupied.update(folded(path) for path in candidates.values())
    return True


def resolve_archive_paths(items):
    from apps.generation.models import Generation
    from apps.library.models import Folder
    from apps.projects.models import Project
    from apps.library.filenames import batch_resolve_generation_filenames
    if not items or len(items) > MAX_ITEMS:
        raise ValueError('Invalid export item count.')
    ids = [item.generation_id for item in items]
    naming = batch_resolve_generation_filenames(ids)
    generations = {str(g.id): g for g in Generation.objects.filter(id__in=ids).only('id', 'folder_id', 'project_id', 'name_owner_id', 'created_at')}
    folders = {}
    pending = {g.folder_id for g in generations.values() if g.folder_id}
    for _ in range(MAX_DEPTH + 1):
        if not pending:
            break
        rows = list(Folder.objects.filter(id__in=pending).values('id', 'name', 'parent_id', 'project_id'))
        if len(rows) != len(pending):
            raise ValueError('Export folder is missing.')
        pending = set()
        for row in rows:
            folders[row['id']] = row
            if row['parent_id'] and row['parent_id'] not in folders:
                pending.add(row['parent_id'])
    if pending:
        raise ValueError('Export folder hierarchy is too deep.')
    projects = {p.id: p.name for p in Project.objects.filter(id__in={g.project_id for g in generations.values() if g.project_id})}
    # Compare siblings in their real scope, including sanitized/casefold aliases.
    groups = defaultdict(list)
    components = {}
    for pid, name in projects.items():
        token = component(name, 'Project')
        components[('project', pid)] = token
        groups[('Projects', folded(token))].append(('project', pid))
    for fid, row in folders.items():
        token = component(row['name'], 'Folder')
        components[('folder', fid)] = token
        groups[(row['project_id'], row['parent_id'], folded(token))].append(('folder', fid))
        # Unsorted is a virtual root folder and must never alias a real folder.
        if not row['parent_id'] and folded(token) == 'unsorted':
            components[('folder', fid)] = suffix(token, fid)
    for aliases in groups.values():
        if len(aliases) > 1:
            for entity in aliases:
                components[entity] = suffix(components[entity], entity[1])
    # A literal display name may itself equal another entity's generated suffix.
    # Resolve these secondary aliases too, without treating names as identities.
    occupied = defaultdict(set)
    for entity in sorted(components, key=lambda value: (value[0], str(value[1]))):
        if entity[0] == 'project':
            scope = ('Projects',)
        else:
            row = folders[entity[1]]
            scope = (row['project_id'], row['parent_id'])
        base = components[entity]
        token, counter = base, 0
        while folded(token) in occupied[scope]:
            counter += 1
            token = suffix(base, entity[1]) + ('_' + str(counter) if counter > 1 else '')
        components[entity] = token
        occupied[scope].add(folded(token))
    paths = {}
    for item in items:
        gid = str(item.generation_id)
        g = generations.get(gid)
        if not g or gid not in naming:
            raise ValueError('Export source metadata is missing.')
        if g.project_id and g.project_id not in projects:
            raise ValueError('Export project is missing.')
        parts = ['Projects', components[('project', g.project_id)]] if g.project_id else ['Global']
        ancestry, seen, fid = [], set(), g.folder_id
        while fid:
            if fid in seen or len(seen) >= MAX_DEPTH:
                raise ValueError('Export folder hierarchy is circular or too deep.')
            seen.add(fid)
            row = folders[fid]
            if row['project_id'] != g.project_id:
                raise ValueError('Export folder scope is inconsistent.')
            ancestry.insert(0, components[('folder', fid)])
            fid = row['parent_id']
        parts.extend(ancestry or ['Unsorted'])
        leaf = naming[gid]['filename']
        paths[gid] = '/'.join(parts + [leaf])
    collisions = defaultdict(list)
    for gid, path in paths.items():
        collisions[folded(path)].append(gid)
    occupied = {folded(path) for path in paths.values()}
    for aliases in collisions.values():
        if len(aliases) > 1 and not lineage_leaves(aliases, generations, paths, occupied):
            # Keep the permanent media leaf even when historical namespaces
            # produced identical names. Archive directories may disambiguate.
            for gid in sorted(aliases):
                parent, leaf = paths[gid].rsplit('/', 1)
                counter = 0
                while True:
                    directory = gid + ('_' + str(counter) if counter else '')
                    candidate = parent + '/' + directory + '/' + leaf
                    if folded(candidate) not in occupied:
                        break
                    counter += 1
                paths[gid] = candidate
                occupied.add(folded(candidate))
    seen = set()
    for path in paths.values():
        safe_zip_member_path(path)
        if folded(path) in seen:
            raise ValueError('Export path collision.')
        seen.add(folded(path))
    return paths
