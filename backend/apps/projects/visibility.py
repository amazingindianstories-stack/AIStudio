"""Who may see a project. One rule, used by every listing and every direct fetch.

'all' is open to every signed-in user (today's behavior and the default). 'users' is open to the users in
`ProjectAccessUser`, the project's creator and admins. 'admin' is open to admins only. A user who may not see a
project gets the same answer as for a missing one. `hidden_project_ids` is the SQL twin of `can_see`.
"""
from apps.projects.models import PROJECT_ACCESS_MODES, Project, ProjectAccessUser


def hidden_project_ids(user):
    """Project ids `user` may not see, as a subquery (empty for admins); exclude them from any listing."""
    if user.role == 'admin':
        return Project.objects.none().values('id')
    allowed = ProjectAccessUser.objects.filter(user_id=user.id).values('project_id')
    return Project.objects.exclude(access='all').exclude(access='users', pk__in=allowed).exclude(
        access='users', created_by=user.id).values('id')


def for_user_id(user_id):
    """The user row for a bare id (what export and worker code carry), or None for an unknown id."""
    from apps.authentication.models import User
    try:
        return User.objects.filter(pk=user_id).only('id', 'role').first()
    except Exception:
        return None


def can_see(user, project_id):
    """True when the project is missing too: callers answer 404 for a missing project separately."""
    if not project_id:
        return True
    try:
        return not Project.objects.filter(pk=project_id, pk__in=hidden_project_ids(user)).exists()
    except Exception:
        return True


def can_see_folder(user, folder_id):
    """True unless the folder sits in a project the user may not see (a missing or global folder is not hidden)."""
    from apps.library.models import Folder
    try:
        return not Folder.objects.filter(pk=folder_id, project_id__in=hidden_project_ids(user)).exists()
    except Exception:
        return True


def visible(user, rows, field='project_id'):
    """`rows` without the ones inside a project the user may not see; rows outside any project stay."""
    return rows.exclude(**{f'{field}__in': hidden_project_ids(user)})


def set_access(project_id, mode, user_ids, now):
    from django.db import transaction
    if mode not in PROJECT_ACCESS_MODES:
        raise ValueError('Invalid access.')
    with transaction.atomic():
        Project.objects.filter(pk=project_id).update(access=mode, updated_at=now)
        ProjectAccessUser.objects.filter(project_id=project_id).delete()
        if mode == 'users':
            ProjectAccessUser.objects.bulk_create([ProjectAccessUser(project_id=project_id, user_id=value, created_at=now)
                for value in dict.fromkeys(user_ids)])
