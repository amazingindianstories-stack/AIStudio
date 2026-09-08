import time
import uuid

from django.test import TestCase

from apps.generation.models import Generation

from . import projects_service
from .models import Folder, Project


class ProjectsServiceTests(TestCase):
    def test_ensure_default_project_creates_exactly_one(self):
        Project.objects.all().delete()
        projects_service.ensure_default_project()
        projects_service.ensure_default_project()
        self.assertEqual(Project.objects.count(), 1)

    def test_delete_project_orphans_generations_not_deletes_them(self):
        now = int(time.time() * 1000)
        project = Project.objects.create(id=uuid.uuid4(), name="P", created_at=now, updated_at=now)
        folder = Folder.objects.create(id=uuid.uuid4(), project_id=project.id, name="F", created_at=now)
        gen = Generation.objects.create(
            id=uuid.uuid4(), kind="image", status="succeeded", prompt="x", model="m",
            aspect_ratio="1:1", project_id=project.id, folder_id=folder.id,
            created_at=now, updated_at=now,
        )
        projects_service.delete_project(str(project.id))
        gen.refresh_from_db()
        self.assertIsNone(gen.project_id)
        self.assertIsNone(gen.folder_id)
        self.assertFalse(Project.objects.filter(id=project.id).exists())

    def test_delete_folder_orphans_only_that_folders_generations(self):
        now = int(time.time() * 1000)
        project = Project.objects.create(id=uuid.uuid4(), name="P", created_at=now, updated_at=now)
        folder = Folder.objects.create(id=uuid.uuid4(), project_id=project.id, name="F", created_at=now)
        gen_in_folder = Generation.objects.create(
            id=uuid.uuid4(), kind="image", status="succeeded", prompt="x", model="m",
            aspect_ratio="1:1", project_id=project.id, folder_id=folder.id,
            created_at=now, updated_at=now,
        )
        gen_elsewhere = Generation.objects.create(
            id=uuid.uuid4(), kind="image", status="succeeded", prompt="x", model="m",
            aspect_ratio="1:1", project_id=project.id, folder_id=None,
            created_at=now, updated_at=now,
        )
        projects_service.delete_folder(str(folder.id))
        gen_in_folder.refresh_from_db()
        gen_elsewhere.refresh_from_db()
        self.assertIsNone(gen_in_folder.folder_id)
        self.assertEqual(gen_in_folder.project_id, project.id)  # project ref untouched
        self.assertIsNone(gen_elsewhere.folder_id)  # was already None

    def test_read_projects_nests_folders_correctly(self):
        now = int(time.time() * 1000)
        p1 = Project.objects.create(id=uuid.uuid4(), name="P1", created_at=now, updated_at=now)
        p2 = Project.objects.create(id=uuid.uuid4(), name="P2", created_at=now + 1, updated_at=now)
        Folder.objects.create(id=uuid.uuid4(), project_id=p1.id, name="F1", created_at=now)
        result = projects_service.read_projects()
        by_id = {p["id"]: p for p in result}
        self.assertEqual(len(by_id[str(p1.id)]["folders"]), 1)
        self.assertEqual(by_id[str(p2.id)]["folders"], [])
