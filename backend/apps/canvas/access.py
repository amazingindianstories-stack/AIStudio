"""Board access: one effective role per (user, board) from every source, the highest winning.

Sources are the board's team access (what every signed-in teammate gets), the user's board
membership, the user's project membership, board ownership (`created_by`) and the admin role.
Every board route asks `role_for`/`roles_for` and compares levels; nothing else decides access.
"""
from apps.authentication.models import User
from apps.projects.models import PROJECT_ROLES, Project, ProjectMember
from .models import BOARD_ROLES, BoardMember, CanvasBoard
from . import services

NONE, VIEW, COMMENT, EDIT, CO_OWNER, OWNER = range(6)
LEVEL_NAMES = {VIEW: 'view', COMMENT: 'comment', EDIT: 'edit', CO_OWNER: 'co_owner', OWNER: 'owner'}
BOARD_LEVELS = {'view': VIEW, 'comment': COMMENT, 'edit': EDIT}
PROJECT_LEVELS = {'viewer': VIEW, 'commenter': COMMENT, 'editor': EDIT, 'co_owner': CO_OWNER, 'owner': OWNER}

# Minimum effective level for each board action.
READ = VIEW
WRITE = EDIT          # save the graph, upload media
SHARE = CO_OWNER      # rename, add/change/remove board members
OWN = OWNER           # delete, team access, transfer ownership


class AccessError(Exception):
    def __init__(self, error, status):
        super().__init__(error)
        self.status = status


def _level(user, board, board_role, project_role):
    if user.role == 'admin' or (board['created_by'] and str(board['created_by']) == str(user.id)):
        return OWNER
    return max(BOARD_LEVELS.get(board['team_role'], NONE), BOARD_LEVELS.get(board_role, NONE),
               PROJECT_LEVELS.get(project_role, NONE))


def roles_for(user, boards):
    """Effective levels keyed by board id string, for rows carrying id, project_id, created_by, team_role."""
    ids = [row['id'] for row in boards]
    projects = {row['project_id'] for row in boards}
    board_roles = dict(BoardMember.objects.filter(user_id=user.id, board_id__in=ids).values_list('board_id', 'role')) if ids else {}
    project_roles = dict(ProjectMember.objects.filter(user_id=user.id, project_id__in=projects).values_list('project_id', 'role')) if projects else {}
    return {str(row['id']): _level(user, row, board_roles.get(row['id']), project_roles.get(row['project_id'])) for row in boards}


def role_for(user, board):
    return roles_for(user, [board])[str(board['id'])]


def require(user, board, needed):
    """Raise unless the user's effective level reaches `needed`; a user who cannot even view gets 404."""
    level = role_for(user, board)
    if level < needed:
        raise AccessError('Board not found.', 404) if level < READ else AccessError('FORBIDDEN', 403)
    return level


def board_row(identifier):
    return CanvasBoard.objects.filter(pk=identifier).values('id', 'project_id', 'created_by', 'team_role').first()


def project_level(user, project_id):
    if user.role == 'admin':
        return OWNER
    role = ProjectMember.objects.filter(project_id=project_id, user_id=user.id).values_list('role', flat=True).first()
    return PROJECT_LEVELS.get(role, NONE)


def can_create_board(user, project_id):
    """Every teammate adds boards until the project has a member besides its creator; then editors and above."""
    creator = Project.objects.filter(pk=project_id).values_list('created_by', flat=True).first()
    restricted = ProjectMember.objects.filter(project_id=project_id).exclude(user_id=creator).exists()
    return not restricted or project_level(user, project_id) >= EDIT


def require_board_creator(user, project_id):
    if not can_create_board(user, project_id):
        raise AccessError('FORBIDDEN', 403)


def active_user(identifier):
    if not isinstance(identifier, str):
        raise AccessError('userId required.', 400)
    try:
        user = User.objects.filter(pk=identifier, is_active=True).values('id').first()
    except Exception:
        user = None
    if user is None:
        raise AccessError('User not found.', 404)
    return user['id']


def describe(user, board):
    """The share dialog's view of a board: owner, team access, members and what the caller may change."""
    level = role_for(user, board)
    project = Project.objects.filter(pk=board['project_id']).values('id').first()
    project_members = list(ProjectMember.objects.filter(project_id=board['project_id']).order_by('created_at').values('user_id', 'role')) if project else []
    mine = project_level(user, board['project_id']) if project else NONE
    return {'boardId': str(board['id']), 'projectId': str(board['project_id']),
            'ownerId': str(board['created_by']) if board['created_by'] else None,
            'teamRole': board['team_role'], 'role': LEVEL_NAMES[level],
            'members': [{'userId': str(row['user_id']), 'role': row['role']} for row in
                        BoardMember.objects.filter(board_id=board['id']).order_by('created_at').values('user_id', 'role')],
            'projectMembers': [{'userId': str(row['user_id']), 'role': row['role']} for row in project_members],
            'canShare': level >= SHARE, 'canOwn': level >= OWN,
            'canManageProject': bool(project) and mine >= CO_OWNER, 'projectRole': LEVEL_NAMES.get(mine)}


def set_board_member(actor, board, user_id, role):
    require(actor, board, SHARE)
    if role not in BOARD_ROLES:
        raise AccessError('Invalid role.', 400)
    target = active_user(user_id)
    if board['created_by'] and str(board['created_by']) == str(target):
        raise AccessError('The board owner already has full access.', 400)
    now = services.now_ms()
    BoardMember.objects.update_or_create(board_id=board['id'], user_id=target,
        defaults={'role': role, 'updated_at': now}, create_defaults={'role': role, 'added_by': actor.id, 'created_at': now, 'updated_at': now})


def remove_board_member(actor, board, user_id):
    require(actor, board, SHARE)
    if not isinstance(user_id, str):
        raise AccessError('userId required.', 400)
    try:
        BoardMember.objects.filter(board_id=board['id'], user_id=user_id).delete()
    except Exception:
        raise AccessError('User not found.', 404)


def set_team_role(actor, board, role):
    require(actor, board, OWN)
    if role not in BOARD_ROLES:
        raise AccessError('Invalid role.', 400)
    # Access changes leave updated_at and version alone: they track the graph, not its sharing.
    CanvasBoard.objects.filter(pk=board['id']).update(team_role=role)


def transfer_owner(actor, board, user_id):
    """The new owner leaves the member list; the previous owner stays on the board as an editor."""
    from django.db import transaction
    require(actor, board, OWN)
    target = active_user(user_id)
    previous = board['created_by']
    if previous and str(previous) == str(target):
        return
    now = services.now_ms()
    with transaction.atomic():
        CanvasBoard.objects.filter(pk=board['id']).update(created_by=target)
        BoardMember.objects.filter(board_id=board['id'], user_id=target).delete()
        if previous and User.objects.filter(pk=previous).exists():
            BoardMember.objects.update_or_create(board_id=board['id'], user_id=previous,
                defaults={'role': 'edit', 'updated_at': now}, create_defaults={'role': 'edit', 'added_by': actor.id, 'created_at': now, 'updated_at': now})


def describe_project(actor, project_id):
    level = project_level(actor, project_id)
    return {'projectId': str(project_id), 'role': LEVEL_NAMES.get(level), 'canManage': level >= CO_OWNER,
            'members': [{'userId': str(row['user_id']), 'role': row['role']} for row in
                        ProjectMember.objects.filter(project_id=project_id).order_by('created_at').values('user_id', 'role')]}


def _require_project_manager(actor, project_id, *roles):
    """Owners manage everyone; co-owners manage only members below owner and cannot grant owner."""
    level = project_level(actor, project_id)
    if level >= OWNER:
        return
    if level >= CO_OWNER and all(PROJECT_LEVELS.get(role, NONE) < OWNER for role in roles):
        return
    raise AccessError('FORBIDDEN', 403)


def project_exists(project_id):
    try:
        return Project.objects.filter(pk=project_id).exists()
    except Exception:
        return False


def set_project_member(actor, project_id, user_id, role):
    if role not in PROJECT_ROLES:
        raise AccessError('Invalid role.', 400)
    target = active_user(user_id)
    current = ProjectMember.objects.filter(project_id=project_id, user_id=target).values_list('role', flat=True).first()
    _require_project_manager(actor, project_id, role, current)
    now = services.now_ms()
    ProjectMember.objects.update_or_create(project_id=project_id, user_id=target,
        defaults={'role': role, 'updated_at': now}, create_defaults={'role': role, 'added_by': actor.id, 'created_at': now, 'updated_at': now})


def remove_project_member(actor, project_id, user_id):
    if not isinstance(user_id, str):
        raise AccessError('userId required.', 400)
    try:
        current = ProjectMember.objects.filter(project_id=project_id, user_id=user_id).values_list('role', flat=True).first()
    except Exception:
        raise AccessError('User not found.', 404)
    _require_project_manager(actor, project_id, current)
    ProjectMember.objects.filter(project_id=project_id, user_id=user_id).delete()
