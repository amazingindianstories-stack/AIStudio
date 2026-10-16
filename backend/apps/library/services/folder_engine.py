"""Folder hierarchy mutation parity with deterministic locking and atomic receipts."""
import os
import re
import unicodedata
from django.db import connection
from django.db.models import F
from apps.library.models import Folder
from apps.projects.models import Project
from apps.generation.models import Generation
from apps.generation.watermark import WHITESPACE
from .idempotency import MISSING, OrganizationError, execute, acquire_scope_locks, now_ms
from .naming import namespace_for, reassign_naming_for_move

COLORS = {'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'}


def limit(name, default):
    try:
        value = float(os.environ.get(name, ''))
        return int(value) if value.is_integer() and value > 0 else default
    except ValueError:
        return default


def sid(value):
    return str(value) if value else None


def scope_key(project_id):
    return f'project:{project_id}' if project_id else 'global'


def folder_json(folder):
    return {'id': str(folder.id), 'name': folder.name, 'color': folder.color,
            'projectId': sid(folder.project_id), 'parentId': sid(folder.parent_id),
            'version': folder.version, 'createdAt': folder.created_at, 'updatedAt': folder.updated_at}


def normalize_name(name):
    if not isinstance(name, str):
        raise OrganizationError('INVALID_NAME', 'Folder name must be a string.')
    value = name.strip(WHITESPACE)
    if not value:
        raise OrganizationError('INVALID_NAME', 'Folder name cannot be empty.')
    # JS string.length counts UTF-16 code units rather than Unicode scalars.
    if len(value.encode('utf-16-le', errors='surrogatepass')) // 2 > 100:
        raise OrganizationError('INVALID_NAME', 'Folder name cannot exceed 100 characters.')
    if re.search('[\x00-\x1f\x7f-\x9f]', value):
        raise OrganizationError('INVALID_NAME', 'Folder name cannot contain control characters.')
    value = unicodedata.normalize('NFKC', value)
    return value, value.lower()


def normalize_color(value):
    if value is None or value == '' or value == 'default':
        return None
    token = str(value).lower().strip(WHITESPACE)
    if token not in COLORS:
        raise OrganizationError('INVALID_COLOR', 'Invalid folder color token.')
    return token


def database_normalized_name(display):
    # Match the frozen trigger's collation-sensitive normalization. Python
    # lower() can disagree with PostgreSQL for non-ASCII names.
    with connection.cursor() as cursor:
        cursor.execute('SELECT LOWER(TRIM(NORMALIZE(%s, NFKC)))', [display])
        return cursor.fetchone()[0]


def audit(actor_id, action, detail):
    if actor_id:
        import uuid
        try:
            uuid.UUID(str(actor_id))
        except (ValueError, TypeError, AttributeError):
            return
        from apps.authentication.models import User
        from apps.common.responses import log_activity
        if User.objects.filter(id=actor_id).exists():
            log_activity(actor_id, action, detail)


def ancestry(folder_id):
    visited, ids, project_id = set(), [], None
    maximum = limit('MAX_NESTING_DEPTH', 20)
    while folder_id:
        key = str(folder_id)
        if key in visited:
            raise OrganizationError('CYCLE_DETECTED', 'Cycle detected in folder hierarchy.', 409)
        visited.add(key)
        ids.append(key)
        if len(ids) > maximum:
            raise OrganizationError('EXCEEDS_MAX_DEPTH', f'Folder nesting exceeds maximum depth of {maximum}.')
        folder = Folder.objects.filter(pk=folder_id).first()
        if not folder:
            raise OrganizationError('FOLDER_NOT_FOUND', f'Folder {folder_id} not found.', 404)
        project_id, folder_id = folder.project_id, folder.parent_id
    return {'depth': len(ids), 'ancestorIds': ids, 'rootProjectId': sid(project_id)}


def descendants(root_id):
    queue, visited, rows = [root_id], {str(root_id)}, []
    maximum = limit('MAX_SUBTREE_FOLDERS', 500)
    while queue:
        for row in Folder.objects.filter(parent_id=queue.pop(0)).order_by('id'):
            if str(row.id) in visited:
                raise OrganizationError('CYCLE_DETECTED', 'Cycle detected during subtree traversal.', 409)
            visited.add(str(row.id))
            rows.append(row)
            queue.append(row.id)
            if len(rows) > maximum:
                raise OrganizationError('SUBTREE_TOO_LARGE', f'Subtree exceeds limit of {maximum} folders.')
    return rows


def normalize_destination(dest):
    if not isinstance(dest, (dict, list)):
        raise OrganizationError('INVALID_DESTINATION', 'Destination descriptor must be an object.')
    dest = {} if isinstance(dest, list) else dest
    kind = dest.get('type')
    if kind not in ('global_root', 'global_unsorted', 'project_root', 'project_unsorted', 'folder'):
        raise OrganizationError('INVALID_DESTINATION', f'Unknown destination type: {kind if kind is not None else "undefined"}')
    if kind in ('project_root', 'project_unsorted') and not dest.get('projectId'):
        raise OrganizationError('INVALID_DESTINATION', f'Destination {kind} requires projectId.')
    if kind == 'folder' and not dest.get('folderId'):
        raise OrganizationError('INVALID_DESTINATION', 'Destination folder requires folderId.')
    return {'type': kind, 'projectId': dest.get('projectId'), 'folderId': dest.get('folderId')}


def locked_folder(folder_id):
    peek = Folder.objects.filter(pk=folder_id).first()
    if not peek:
        raise OrganizationError('FOLDER_NOT_FOUND', 'Folder not found.', 404)
    scope = scope_key(peek.project_id)
    acquire_scope_locks(scope)
    row = Folder.objects.select_for_update().filter(pk=folder_id).first()
    if not row:
        raise OrganizationError('FOLDER_NOT_FOUND', 'Folder not found.', 404)
    if scope_key(row.project_id) != scope:
        raise OrganizationError('SCOPE_MISMATCH', 'Folder scope changed concurrently.', 409)
    return row


def check_project(row, project_id):
    if project_id is not MISSING and sid(project_id) != sid(row.project_id):
        raise OrganizationError('PROJECT_MISMATCH', 'Project mismatch: Folder does not belong to the specified project.', 403)


def check_version(row, expected):
    if expected is not MISSING and (type(expected) not in (int, float) or row.version != expected):
        raise OrganizationError('VERSION_CONFLICT', 'Folder has been modified by another operation.', 409)


def siblings(parent_id, project_id, normalized, exclude=None):
    query = Folder.objects.filter(parent_id=parent_id, name_normalized=normalized)
    if not parent_id:
        query = query.filter(project_id=project_id)
    return query.exclude(pk=exclude).exists() if exclude else query.exists()


def create_folder(*, name=None, color=None, project_id=None, parent_id=None, actor_id=None, idempotency_key=None):
    display, normalized = normalize_name(name)
    color = normalize_color(color)
    def mutate():
        target_project = project_id
        if parent_id:
            peek = Folder.objects.filter(pk=parent_id).first()
            if not peek:
                raise OrganizationError('FOLDER_NOT_FOUND', 'Parent folder does not exist.', 404)
            target_project = peek.project_id
        acquire_scope_locks(scope_key(target_project))
        if parent_id:
            parent = Folder.objects.select_for_update().filter(pk=parent_id).first()
            if not parent:
                raise OrganizationError('FOLDER_NOT_FOUND', 'Parent folder does not exist.', 404)
            if sid(parent.project_id) != sid(target_project):
                raise OrganizationError('SCOPE_MISMATCH', 'Parent folder scope changed concurrently.', 409)
            maximum = limit('MAX_NESTING_DEPTH', 20)
            if ancestry(parent_id)['depth'] >= maximum:
                raise OrganizationError('EXCEEDS_MAX_DEPTH', f'Cannot exceed maximum folder depth of {maximum}.')
        elif target_project and not Project.objects.select_for_update().filter(pk=target_project).first():
            raise OrganizationError('PROJECT_NOT_FOUND', 'Specified project does not exist.', 404)
        stored_normalized = database_normalized_name(display)
        if siblings(parent_id, target_project, stored_normalized):
            message = f'A folder named "{display}" already exists in this location.' if parent_id else (f'A root folder named "{display}" already exists in this project.' if target_project else f'A root folder named "{display}" already exists in the Global Library.')
            raise OrganizationError('DUPLICATE_FOLDER_NAME', message, 409)
        now = now_ms()
        folder = Folder.objects.create(name=display, name_normalized=normalized, color=color,
            project_id=target_project, parent_id=parent_id, version=1, created_at=now, updated_at=now)
        if target_project:
            Project.objects.filter(pk=target_project).update(updated_at=now)
        result = folder_json(folder)
        audit(actor_id, 'create_folder', {k: result[k] for k in ('name', 'color', 'projectId', 'parentId')} | {'folderId': result['id']})
        return result
    return execute('create_folder', {'name': name, 'color': color, 'projectId': project_id, 'parentId': parent_id}, mutate, actor_id=actor_id, idempotency_key=idempotency_key)


def rename_folder(*, folder_id, name, project_id=MISSING, expected_version=MISSING, actor_id=None, idempotency_key=None):
    display, normalized = normalize_name(name)
    def mutate():
        folder = locked_folder(folder_id)
        check_project(folder, project_id)
        check_version(folder, expected_version)
        if siblings(folder.parent_id, folder.project_id, database_normalized_name(display), folder.id):
            raise OrganizationError('DUPLICATE_FOLDER_NAME', f'A folder named "{display}" already exists in this location.', 409)
        old_name = folder.name
        folder.name, folder.name_normalized = display, normalized
        folder.version, folder.updated_at = folder.version + 1, now_ms()
        folder.save(update_fields=['name', 'name_normalized', 'version', 'updated_at'])
        audit(actor_id, 'rename_folder', {'folderId': str(folder_id), 'oldName': old_name, 'newName': display})
        return folder_json(folder)
    return execute('rename_folder', {'folderId': str(folder_id), 'projectId': project_id, 'name': name, 'expectedVersion': expected_version}, mutate, actor_id=actor_id, idempotency_key=idempotency_key)


def set_folder_color(*, folder_id, color=None, actor_id=None, idempotency_key=None):
    color = normalize_color(color)
    def mutate():
        folder = locked_folder(folder_id)
        old_color = folder.color
        folder.color, folder.version, folder.updated_at = color, folder.version + 1, now_ms()
        folder.save(update_fields=['color', 'version', 'updated_at'])
        audit(actor_id, 'set_folder_color', {'folderId': str(folder_id), 'oldColor': old_color, 'newColor': color})
        return folder_json(folder)
    return execute('set_folder_color', {'folderId': str(folder_id), 'color': color}, mutate, actor_id=actor_id, idempotency_key=idempotency_key)


def delete_folder(*, folder_id, project_id=MISSING, actor_id=None, idempotency_key=None):
    def mutate():
        folder = locked_folder(folder_id)
        check_project(folder, project_id)
        if Folder.objects.filter(parent_id=folder_id).exists():
            raise OrganizationError('FOLDER_NOT_EMPTY', 'Folder cannot be deleted because it contains subfolders. Remove or move subfolders first.')
        if Generation.objects.filter(folder_id=folder_id).exists():
            raise OrganizationError('FOLDER_NOT_EMPTY', 'Folder cannot be deleted because it contains items. Move items out before deleting.')
        detail = {'folderId': str(folder_id), 'name': folder.name, 'projectId': sid(folder.project_id)}
        folder.delete()
        audit(actor_id, 'delete_folder', detail)
        return {'success': True, 'deletedFolderId': str(folder_id)}
    return execute('delete_folder', {'folderId': str(folder_id), 'projectId': project_id}, mutate, actor_id=actor_id, idempotency_key=idempotency_key)


def move_folder(*, folder_id, destination, expected_version=MISSING, actor_id=None, idempotency_key=None):
    dest = normalize_destination(destination)
    def mutate():
        source_peek = Folder.objects.filter(pk=folder_id).first()
        if not source_peek:
            raise OrganizationError('FOLDER_NOT_FOUND', 'Folder not found.', 404)
        target_peek = None
        if dest['type'] == 'folder':
            target_peek = Folder.objects.filter(pk=dest['folderId']).first()
            if not target_peek:
                raise OrganizationError('DESTINATION_NOT_FOUND', 'Target destination folder not found.', 404)
        target_project = target_peek.project_id if target_peek else (dest['projectId'] if dest['type'] == 'project_root' else None)
        source_scope, target_scope = scope_key(source_peek.project_id), scope_key(target_project)
        acquire_scope_locks(source_scope, target_scope)
        if target_peek and str(target_peek.id) == str(folder_id):
            raise OrganizationError('CANNOT_MOVE_INTO_SELF', 'Cannot move a folder into itself.')
        ids = [folder_id] + ([target_peek.id] if target_peek else [])
        rows = {str(r.id): r for r in Folder.objects.select_for_update().filter(pk__in=ids).order_by('id')}
        source, target = rows.get(str(folder_id)), rows.get(str(target_peek.id)) if target_peek else None
        if not source:
            raise OrganizationError('FOLDER_NOT_FOUND', 'Folder not found.', 404)
        if target_peek and not target:
            raise OrganizationError('DESTINATION_NOT_FOUND', 'Target destination folder not found.', 404)
        if scope_key(source.project_id) != source_scope or (target and scope_key(target.project_id) != target_scope):
            raise OrganizationError('SCOPE_MISMATCH', 'Folder scope changed concurrently.', 409)
        check_version(source, expected_version)
        target_parent, depth = None, 0
        if target:
            info = ancestry(target.id)
            if str(folder_id) in info['ancestorIds']:
                raise OrganizationError('CYCLE_DETECTED', 'Cannot move a folder into one of its descendants.')
            depth, target_parent, target_project = info['depth'], target.id, target.project_id
            duplicate = f'A folder named "{source.name}" already exists in the destination.'
        elif dest['type'] == 'project_root':
            if not Project.objects.select_for_update().filter(pk=target_project).first():
                raise OrganizationError('PROJECT_NOT_FOUND', 'Destination project does not exist.', 404)
            duplicate = f'A root folder named "{source.name}" already exists in the destination project.'
        elif dest['type'] == 'global_root':
            duplicate = f'A root folder named "{source.name}" already exists in the Global Library.'
        else:
            raise OrganizationError('INVALID_DESTINATION', f'Cannot move folder to destination type: {dest["type"]}')
        if siblings(target_parent, target_project, source.name_normalized, source.id):
            raise OrganizationError('DUPLICATE_FOLDER_NAME', duplicate, 409)
        children = descendants(folder_id)
        heights = {str(folder_id): 1}
        for child in children:
            heights[str(child.id)] = heights.get(str(child.parent_id), 1) + 1
        maximum = limit('MAX_NESTING_DEPTH', 20)
        if depth + max(heights.values()) > maximum:
            raise OrganizationError('EXCEEDS_MAX_DEPTH', f'Moving this folder subtree would exceed maximum depth of {maximum}.')
        changed = sid(source.project_id) != sid(target_project)
        detail = {'folderId': str(folder_id), 'sourceParentId': sid(source.parent_id), 'sourceProjectId': sid(source.project_id), 'targetParentId': sid(target_parent), 'targetProjectId': sid(target_project)}
        now = now_ms()
        source.parent_id, source.project_id = target_parent, target_project
        source.version, source.updated_at = source.version + 1, now
        source.save(update_fields=['parent', 'project', 'version', 'updated_at'])
        if changed:
            Folder.objects.filter(pk__in=[r.id for r in children]).update(project_id=target_project, version=F('version') + 1, updated_at=now)
            Generation.objects.filter(folder_id__in=[source.id] + [r.id for r in children]).update(project_id=target_project, location_version=F('location_version') + 1, updated_at=now)
        audit(actor_id, 'move_folder', detail)
        return {'folder': folder_json(source), 'subtreeFolderCount': 1 + len(children), 'scopeChanged': changed}
    return execute('move_folder', {'folderId': str(folder_id), 'destination': dest, 'expectedVersion': expected_version}, mutate, actor_id=actor_id, idempotency_key=idempotency_key)


def move_generations(*, ids, destination, expected_versions=MISSING, actor_id=None, idempotency_key=None):
    if not isinstance(ids, list) or not ids:
        return {'movedCount': 0, 'items': []}
    seen = set()
    for identifier in ids:
        if identifier in seen:
            raise OrganizationError('DUPLICATE_GENERATION_IDS', f'Duplicate generation ID detected in batch: {identifier}')
        seen.add(identifier)
    maximum = limit('MAX_GENERATION_BATCH', 1000)
    if len(ids) > maximum:
        raise OrganizationError('BATCH_TOO_LARGE', f'Cannot move more than {maximum} generations in a single batch.')
    dest = normalize_destination(destination)
    sorted_ids = sorted(ids)
    def mutate():
        target_project, target_folder = None, None
        if dest['type'] == 'folder':
            peek = Folder.objects.filter(pk=dest['folderId']).first()
            if not peek:
                raise OrganizationError('DESTINATION_NOT_FOUND', 'Destination folder does not exist.', 404)
            target_project, target_folder = peek.project_id, peek.id
        elif dest['type'] in ('project_root', 'project_unsorted'):
            target_project = dest['projectId']
        source = list(Generation.objects.filter(pk__in=sorted_ids).order_by('id'))
        def check_found(rows):
            found = {str(r.id) for r in rows}
            missing = next((i for i in sorted_ids if i not in found), None)
            if missing:
                raise OrganizationError('GENERATION_NOT_FOUND', f'Generation {missing} not found.', 404)
        check_found(source)
        scopes = {scope_key(r.project_id) for r in source} | {scope_key(target_project)}
        acquire_scope_locks(*scopes)
        if target_folder:
            folder = Folder.objects.select_for_update().filter(pk=target_folder).first()
            if not folder:
                raise OrganizationError('DESTINATION_NOT_FOUND', 'Destination folder does not exist.', 404)
            if scope_key(folder.project_id) not in scopes:
                # Abort rather than invert sorted lock order when a concurrent move changes scope.
                raise OrganizationError('SCOPE_MISMATCH', 'Folder scope changed concurrently.', 409)
            target_project = folder.project_id
        elif target_project and not Project.objects.select_for_update().filter(pk=target_project).first():
            raise OrganizationError('PROJECT_NOT_FOUND', 'Destination project does not exist.', 404)
        rows = list(Generation.objects.select_for_update().filter(pk__in=sorted_ids).order_by('id'))
        check_found(rows)
        if any(scope_key(r.project_id) not in scopes for r in rows):
            raise OrganizationError('SCOPE_MISMATCH', 'Generation scope changed concurrently.', 409)
        if isinstance(expected_versions, dict):
            for row in rows:
                expected = expected_versions.get(str(row.id), MISSING)
                if expected is not MISSING and (type(expected) not in (int, float) or expected != row.location_version):
                    raise OrganizationError('VERSION_CONFLICT', f'Generation {row.id} has locationVersion {row.location_version} but expected {expected}.', 409)
        now = now_ms()
        Generation.objects.filter(pk__in=sorted_ids).update(project_id=target_project, folder_id=target_folder, location_version=F('location_version') + 1, updated_at=now)
        naming = reassign_naming_for_move(rows, namespace_for(target_folder, target_project), now)
        audit(actor_id, 'move_generations', {'count': len(ids), 'destinationType': dest['type'], 'projectId': sid(target_project), 'folderId': sid(target_folder)})
        return {'movedCount': len(rows), 'projectId': sid(target_project), 'folderId': sid(target_folder), 'updatedIds': [str(r.id) for r in rows], 'reallocatedNamingCount': naming['reallocatedCount'], 'preservedNamingCount': naming['preservedCount'], 'assignments': naming['assignments']}
    return execute('move_generations', {'ids': sorted_ids, 'destination': dest, 'expectedVersions': expected_versions}, mutate, actor_id=actor_id, idempotency_key=idempotency_key)
