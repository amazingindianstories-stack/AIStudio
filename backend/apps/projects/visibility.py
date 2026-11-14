"""Who may see a project. One rule, used by every listing and every direct fetch.

'all' is open to every signed-in user (today's behavior and the default). 'users' is open to the users in
`ProjectAccessUser`, the project's creator and admins. 'admin' is open to admins only. A user who may not see a
project gets the same answer as for a missing one. `hidden_project_ids` is the SQL twin of `can_see`.
"""
from django.core.exceptions import ValidationError
from django.db import DataError
from apps.projects.models import PROJECT_ACCESS_MODES, Project, ProjectAccessUser

# A malformed id matches no row; only these mean "not hidden". Any other failure propagates, so a check fails closed.
MALFORMED = (ValidationError, DataError, ValueError, TypeError)


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
    if not user_id:
        return None
    try:
        return User.objects.filter(pk=user_id).only('id', 'role').first()
    except MALFORMED:
        return None


def can_see(user, project_id):
    """True when the project is missing too: callers answer 404 for a missing project separately."""
    if not project_id:
        return True
    try:
        return not Project.objects.filter(pk=project_id, pk__in=hidden_project_ids(user)).exists()
    except MALFORMED:
        return True


def can_see_folder(user, folder_id):
    """True unless the folder sits in a project the user may not see (a missing or global folder is not hidden)."""
    from apps.library.models import Folder
    try:
        return not Folder.objects.filter(pk=folder_id, project_id__in=hidden_project_ids(user)).exists()
    except MALFORMED:
        return True


def can_see_generation(user, generation_id):
    """False for a generation inside a project the user may not see; a missing id stays the caller's 404."""
    from apps.generation.models import Generation
    try:
        return not Generation.objects.filter(pk=generation_id, project_id__in=hidden_project_ids(user)).exists()
    except MALFORMED:
        return True


def can_see_media_key(user, key):
    """False for stored media of a generation or asset inside a project the user may not see.

    `generations/<id>...`, `references/<id>-...` and `depth-output/<id>...` name their generation, and
    `canvas/<board>/...` and `talktrack/<board>/...` their board; legacy `generated/...` masters and
    `assets/...` images name none, so the generation or asset row that stores the key is looked up."""
    import re
    from apps.assets.models import Asset
    from apps.canvas.models import CanvasBoard
    from apps.generation.models import Generation
    match = re.match(r'(?:generations/|references/|depth-output/)([0-9a-fA-F-]{36})(?:[./-]|$)', key)
    if match:
        return can_see_generation(user, match[1])
    hidden = hidden_project_ids(user)
    board = re.match(r'(?:canvas|talktrack)/([0-9a-fA-F-]{36})/', key)
    if board:
        try:
            return not CanvasBoard.objects.filter(pk=board[1], project_id__in=hidden).exists()
        except MALFORMED:
            return True
    if key.startswith('generated/'):
        return not Generation.objects.filter(project_id__in=hidden, url__endswith='/' + key).exists()
    if key.startswith('assets/'):
        return not Asset.objects.filter(project_id__in=hidden, images__icontains=key).exists()
    return True


def visible(user, rows, field='project_id'):
    """`rows` without the ones inside a project the user may not see; rows outside any project stay."""
    return rows.exclude(**{f'{field}__in': hidden_project_ids(user)})


def visible_to(user_id, rows, field='project_id'):
    """`visible` for a bare user id, as workers carry it; rows of an unknown user are left as they are."""
    owner = for_user_id(user_id)
    return visible(owner, rows, field) if owner else rows


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
