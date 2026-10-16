from django.db import connection, transaction
from apps.library.models import Folder
from apps.library.services import folder_engine as folders
from apps.library.services.idempotency import OrganizationError, now_ms
from apps.projects.models import Project


def read_projects():
    grouped = {}
    for folder in Folder.objects.order_by('created_at'):
        grouped.setdefault(folder.project_id, []).append({'id': str(folder.id), 'name': folder.name, 'createdAt': folder.created_at})
    result = []
    for project in Project.objects.order_by('created_at'):
        row = {'id': str(project.id), 'name': project.name, 'createdAt': project.created_at,
            'updatedAt': project.updated_at, 'folders': grouped.get(project.id, [])}
        if project.brief is not None:
            row['brief'] = project.brief
        result.append(row)
    return result


def ensure_default_project():
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(815042)')
        if not Project.objects.exists():
            now = now_ms()
            Project.objects.create(name='My Project', brief=None, created_by=None, created_at=now, updated_at=now)
    return read_projects()


def create_project(name, actor_id=None):
    now = now_ms()
    row = Project.objects.create(name=name, created_by=actor_id, created_at=now, updated_at=now)
    return {'projects': read_projects(), 'project': {'id': str(row.id), 'name': row.name,
        'folders': [], 'createdAt': now, 'updatedAt': now}}


def rename_project(project_id, name):
    Project.objects.filter(pk=project_id).update(name=name, updated_at=now_ms())
    return read_projects()


def set_brief(project_id, brief):
    Project.objects.filter(pk=project_id).update(brief=brief, updated_at=now_ms())
    return read_projects()


def delete_project(project_id, actor_id=None):
    from apps.generation.models import Generation
    with transaction.atomic():
        folders.acquire_scope_locks(folders.scope_key(project_id))
        row = Project.objects.select_for_update().filter(pk=project_id).first()
        if not row:
            raise OrganizationError('PROJECT_NOT_FOUND', 'Project not found.', 404)
        if Folder.objects.filter(project_id=project_id).exists():
            raise OrganizationError('PROJECT_NOT_EMPTY', 'Cannot delete project: project contains folders. Remove or move folders first.')
        if Generation.objects.filter(project_id=project_id).exists():
            raise OrganizationError('PROJECT_NOT_EMPTY', 'Cannot delete project: project contains generations. Remove or move items first.')
        row.delete()
        folders.audit(actor_id, 'delete_project', {'projectId': str(project_id)})
    return read_projects()
