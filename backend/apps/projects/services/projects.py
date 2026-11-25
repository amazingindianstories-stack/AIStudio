from django.db import connection, transaction
from apps.library.models import Folder
from apps.library.services import folder_engine as folders
from apps.library.services.idempotency import OrganizationError, now_ms
from apps.projects.models import Project, ProjectAccessUser, ProjectMember
from apps.projects import visibility


def read_projects(user=None):
    """Every project; with `user`, only the ones that user may see, each with its access mode."""
    grouped = {}
    projects = Project.objects.order_by('created_at')
    folder_rows = Folder.objects.order_by('created_at')
    if user is not None:
        projects = visibility.visible(user, projects, 'pk')
        folder_rows = visibility.visible(user, folder_rows)
    allowed = {}
    for link in ProjectAccessUser.objects.filter(project__in=projects).order_by('created_at'):
        allowed.setdefault(link.project_id, []).append(str(link.user_id))
    for folder in folder_rows:
        grouped.setdefault(folder.project_id, []).append({'id': str(folder.id), 'name': folder.name, 'createdAt': folder.created_at})
    result = []
    for project in projects:
        row = {'id': str(project.id), 'name': project.name, 'createdAt': project.created_at,
            'updatedAt': project.updated_at, 'folders': grouped.get(project.id, []), 'access': project.access}
        if project.access == 'users':
            row['accessUserIds'] = allowed.get(project.id, [])
        if project.brief is not None:
            row['brief'] = project.brief
        result.append(row)
    return result


def ensure_default_project(user=None):
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(815042)')
        if not Project.objects.exists():
            now = now_ms()
            Project.objects.create(name='My Project', brief=None, created_by=None, created_at=now, updated_at=now)
    return read_projects(user)


def validate_access(mode, user_ids):
    """Refuse an unknown access mode, and a 'users' mode without a list of active users."""
    from apps.authentication.models import User
    if mode not in ('all', 'users', 'admin'):
        raise OrganizationError('INVALID_ACCESS', 'Access must be all, users or admin.')
    if not isinstance(user_ids, list) or not all(isinstance(value, str) for value in user_ids):
        raise OrganizationError('INVALID_ACCESS', 'userIds must be a list of user ids.')
    if mode == 'users':
        try:
            found = set(str(value) for value in User.objects.filter(pk__in=user_ids, is_active=True).values_list('id', flat=True))
        except visibility.MALFORMED:
            found = set()
        if not user_ids or found != set(user_ids):
            raise OrganizationError('INVALID_ACCESS', 'Pick at least one active user.')


def require_level(user, project_id, level):
    """Role gate for project mutations. A project with no member besides its creator keeps the open studio
    behavior (every teammate who can see it); once it has other members the project roles are enforced."""
    from apps.canvas import access
    if user is None or not project_id or user.role == 'admin':
        return
    try:
        creator = Project.objects.filter(pk=project_id).values_list('created_by', flat=True).first()
        members = ProjectMember.objects.filter(project_id=project_id)
        restricted = (members.exclude(user_id=creator) if creator else members).exists()
    except visibility.MALFORMED:
        return
    if restricted and access.project_level(user, project_id) < level:
        raise OrganizationError('FORBIDDEN', 'Only project owners, co-owners and admins can do this.', 403)


def require_folder_level(user, folder_id, level):
    """The project role gate for a mutation that names a folder, applied to the folder's project."""
    if not folder_id:
        return
    try:
        project_id = Folder.objects.filter(pk=folder_id).values_list('project_id', flat=True).first()
    except visibility.MALFORMED:
        return
    require_level(user, project_id, level)


def create_project(name, actor_id=None, access='all', access_user_ids=None, user=None):
    access_user_ids = [] if access_user_ids is None else access_user_ids
    if access == 'admin' and user is not None and user.role != 'admin':
        raise OrganizationError('INVALID_ACCESS', 'Only admins can create admin-only projects.', 403)
    validate_access(access, access_user_ids)
    if access == 'users' and actor_id and str(actor_id) not in access_user_ids:
        # The creator never loses a project it just made.
        access_user_ids = [*access_user_ids, str(actor_id)]
    now = now_ms()
    with transaction.atomic():
        row = Project.objects.create(name=name, created_by=actor_id, created_at=now, updated_at=now)
        if access != 'all':
            visibility.set_access(row.id, access, access_user_ids, now)
        if actor_id:
            # The creator owns a new project; existing projects keep only explicit members.
            ProjectMember.objects.create(project=row, user_id=actor_id, role='owner', added_by=actor_id, created_at=now, updated_at=now)
    return {'projects': read_projects(user), 'project': {'id': str(row.id), 'name': row.name,
        'folders': [], 'createdAt': now, 'updatedAt': now, 'access': access}}


def rename_project(project_id, name, user=None):
    from apps.canvas import access
    require_level(user, project_id, access.CO_OWNER)
    Project.objects.filter(pk=project_id).update(name=name, updated_at=now_ms())
    return read_projects(user)


def set_brief(project_id, brief, user=None):
    from apps.canvas import access
    require_level(user, project_id, access.CO_OWNER)
    Project.objects.filter(pk=project_id).update(brief=brief, updated_at=now_ms())
    return read_projects(user)


def set_project_access(project_id, mode, user_ids, user):
    """Admins and project owners/co-owners choose who sees a project; 'users' needs a list of active users."""
    from apps.canvas import access
    validate_access(mode, user_ids)
    if access.project_level(user, project_id) < access.CO_OWNER:
        raise OrganizationError('FORBIDDEN', 'Only admins and project owners can change project access.', 403)
    visibility.set_access(project_id, mode, user_ids, now_ms())
    return read_projects(user)


def delete_project(project_id, actor_id=None, user=None):
    from apps.generation.models import Generation
    from apps.canvas import access
    require_level(user, project_id, access.CO_OWNER)
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
    return read_projects(user)
