from concurrent.futures import ThreadPoolExecutor
from django.db import connections
from django.test import TransactionTestCase
from apps.library.tests import FolderReadTests
from apps.admin_dashboard.tests import SettingsTests
from .models import Project
from .views import ensure_default_project

class ProjectReadTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = FolderReadTests.setUp

    def test_authenticated_shape_and_no_extra_default(self):
        self.assertEqual(self.client.get('/api/projects').status_code,401)
        self.cookie()
        response=self.client.get('/api/projects')
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(response.json()['projects']),1)
        self.assertNotIn('brief',response.json()['projects'][0])
        self.assertEqual(response.json()['projects'][0]['folders'],[])
        self.assertEqual(Project.objects.count(),1)

    def test_concurrent_empty_reads_create_one_default(self):
        from apps.library.models import Folder
        # Delete leaves before roots: production folder FKs deliberately RESTRICT.
        Folder.objects.filter(parent_id__isnull=False).delete()
        Folder.objects.all().delete()
        Project.objects.all().delete()
        def call():
            try:
                ensure_default_project()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _:call(),range(12)))
        self.assertEqual(Project.objects.count(),1)
        project=Project.objects.get()
        self.assertEqual(project.name,'My Project')
        self.assertIsNone(project.created_by)
        self.assertEqual(project.created_at,project.updated_at)
