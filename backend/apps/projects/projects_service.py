"""Port of src/lib/projects-db.js. Project + folder persistence."""

import time
import uuid

from django.db import connection, transaction

from apps.generation.models import Generation

from .models import Folder, Project

# Same advisory-lock key as ensureDefaultProject() in projects-db.js — must
# stay numerically identical, or a concurrent Next.js + Django request could
# both pass the check and create two default projects.
_DEFAULT_PROJECT_LOCK_KEY = 815042


def _serialize_project(project: Project, folders_by_project: dict) -> dict:
    return {
        "id": str(project.id),
        "name": project.name,
        "brief": project.brief,
        "createdAt": project.created_at,
        "updatedAt": project.updated_at,
        "folders": [
            {"id": str(f.id), "name": f.name, "createdAt": f.created_at}
            for f in folders_by_project.get(project.id, [])
        ],
    }


def read_projects() -> list[dict]:
    projects = list(Project.objects.order_by("created_at"))
    folders = list(Folder.objects.order_by("created_at"))
    by_project: dict = {}
    for f in folders:
        by_project.setdefault(f.project_id, []).append(f)
    return [_serialize_project(p, by_project) for p in projects]


def get_project(project_id: str) -> dict | None:
    return next((p for p in read_projects() if p["id"] == project_id), None)


def ensure_default_project() -> list[dict]:
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("select pg_advisory_xact_lock(%s)", [_DEFAULT_PROJECT_LOCK_KEY])
        if not Project.objects.exists():
            now = int(time.time() * 1000)
            Project.objects.create(
                id=uuid.uuid4(), name="My Project", created_at=now, updated_at=now
            )
    return read_projects()


def create_project(name: str, created_by: str | None = None) -> dict:
    now = int(time.time() * 1000)
    project = Project.objects.create(
        id=uuid.uuid4(), name=name, created_by=created_by, created_at=now, updated_at=now
    )
    return {
        "projects": read_projects(),
        "project": {
            "id": str(project.id),
            "name": project.name,
            "brief": None,
            "folders": [],
            "createdAt": project.created_at,
            "updatedAt": project.updated_at,
        },
    }


def rename_project(project_id: str, name: str) -> list[dict]:
    Project.objects.filter(id=project_id).update(name=name, updated_at=int(time.time() * 1000))
    return read_projects()


def set_brief(project_id: str, brief: str) -> list[dict]:
    Project.objects.filter(id=project_id).update(brief=brief, updated_at=int(time.time() * 1000))
    return read_projects()


def clear_project_refs(project_id: str) -> None:
    """Orphan every item in a project back to global history (project deleted)."""
    Generation.objects.filter(project_id=project_id).update(project_id=None, folder_id=None)


def clear_folder_refs(folder_id: str) -> None:
    Generation.objects.filter(folder_id=folder_id).update(folder_id=None)


def delete_project(project_id: str) -> list[dict]:
    Folder.objects.filter(project_id=project_id).delete()
    Project.objects.filter(id=project_id).delete()
    clear_project_refs(project_id)
    return read_projects()


def create_folder(project_id: str, name: str) -> dict:
    now = int(time.time() * 1000)
    folder = Folder.objects.create(id=uuid.uuid4(), project_id=project_id, name=name, created_at=now)
    Project.objects.filter(id=project_id).update(updated_at=now)
    return {
        "projects": read_projects(),
        "folder": {"id": str(folder.id), "name": folder.name, "createdAt": folder.created_at},
    }


def rename_folder(folder_id: str, name: str) -> list[dict]:
    Folder.objects.filter(id=folder_id).update(name=name)
    return read_projects()


def delete_folder(folder_id: str) -> list[dict]:
    Folder.objects.filter(id=folder_id).delete()
    clear_folder_refs(folder_id)
    return read_projects()
