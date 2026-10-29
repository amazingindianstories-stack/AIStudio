"""Canvas persistence preserves the shared-board ownership contract."""
import time
import uuid
from .models import CanvasBoard
from .serialization import empty_state

META_FIELDS = ('id', 'project_id', 'name', 'created_by', 'created_at', 'updated_at', 'team_role')


def now_ms():
    return int(time.time() * 1000)


def metadata(row):
    return {'id': str(row['id']), 'projectId': str(row['project_id']), 'name': row['name'],
            'createdBy': str(row['created_by']) if row['created_by'] else None,
            'createdAt': row['created_at'], 'updatedAt': row['updated_at'], 'teamRole': row['team_role']}


def list_boards(project, user):
    """The project's boards the user may at least view, each carrying the user's effective role."""
    from . import access
    rows = list(CanvasBoard.objects.filter(project_id=project).values(*META_FIELDS))
    levels = access.roles_for(user, rows)
    return [{**metadata(row), 'role': access.LEVEL_NAMES[levels[str(row['id'])]]}
            for row in rows if levels[str(row['id'])] >= access.READ]


def get_board(identifier):
    row = CanvasBoard.objects.filter(pk=identifier).values(*META_FIELDS, 'data').first()
    return {**metadata(row), 'data': row['data']} if row else None


def create_board(project, name, user):
    now = now_ms()
    row = CanvasBoard.objects.create(id=uuid.uuid4(), project_id=project, name=name, data=empty_state(),
                                     created_by=user.id, created_at=now, updated_at=now)
    return {**metadata({**{field: getattr(row, field) for field in META_FIELDS}, 'team_role': 'edit'}), 'role': 'owner'}


def rename_board(identifier, name):
    CanvasBoard.objects.filter(pk=identifier).update(name=name, updated_at=now_ms())


def delete_board(identifier):
    CanvasBoard.objects.filter(pk=identifier).delete()


def save_board(identifier, data):
    now = now_ms()
    return now if CanvasBoard.objects.filter(pk=identifier).update(data=data, updated_at=now) else None
