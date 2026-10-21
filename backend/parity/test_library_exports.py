"""Names and ZIP masters are pinned through HTTP and management commands."""
import io
import json
import uuid
import tempfile
from pathlib import Path
from zipfile import ZipFile

from django.apps import apps
from django.test import override_settings
from .support import ParityCase


class LibraryExportParityTests(ParityCase):
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory(prefix='parity-media-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.enterContext(override_settings(VEEVEE_MEDIA_CONFIG={'backend': 'filesystem', 'root': str(self.root)},
                                            VEEVEE_MEDIA_STORAGE=None))

    def folder(self, name, parent=None, project=None):
        response = self.post('/api/folders', {'name': name, 'parentId': parent, 'projectId': project})
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()['folder']['id']

    def generation(self, folder=None, project=None, kind='image'):
        extension = 'mov' if kind == 'video' else 'png'
        data = b'\x00\x00\x00\x14ftypqt  native-master' if kind == 'video' else b'original-png-master'
        key = f'generated/{uuid.uuid4()}.{extension}'
        path = self.root / 'objects' / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        metadata = self.root / 'metadata' / key
        metadata.parent.mkdir(parents=True, exist_ok=True)
        metadata.write_text(json.dumps({'content_type': 'video/quicktime' if kind == 'video' else 'image/png', 'cache_control': 'private, no-store'}))
        row = apps.get_model('generation', 'Generation').objects.create(
            kind=kind, status='completed', model='fixture', prompt='fixture', aspect_ratio='1:1',
            url='/api/media/' + key, folder_id=folder, project_id=project, user_id=self.actor.id,
            created_at=1, updated_at=1)
        return row, data

    def download(self, row, expected, data):
        response = self.client.get(f'/api/generations/{row.id}/download')
        self.assertEqual(response.status_code, 200, response.status_code)
        self.assertIn(f'filename="{expected}"', response['Content-Disposition'])
        self.assertEqual(b''.join(response.streaming_content), data)
        response.close()

    def test_names_follow_parent_rename_and_folder_and_generation_moves(self):
        outer = self.folder('Outer')
        inner = self.folder('Inner Shot', outer)
        other = self.folder('Other')
        row, data = self.generation(inner)
        self.download(row, 'Outer_Inner_Shot_0001.png', data)
        response = self.client.patch('/api/folders', {'id': outer, 'name': 'Renamed'}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        self.download(row, 'Renamed_Inner_Shot_0001.png', data)
        response = self.client.patch('/api/folders', {'id': inner, 'destination': {'type': 'folder', 'folderId': other}}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        self.download(row, 'Other_Inner_Shot_0001.png', data)
        for _ in range(2):
            response = self.post('/api/history/move', {'ids': [str(row.id)], 'destination': {'type': 'folder', 'folderId': other}})
            self.assertEqual(response.status_code, 200, response.content)
            self.download(row, 'Other_0001.png', data)
        response = self.post('/api/history/move', {'ids': [str(row.id)], 'destination': {'type': 'global_root'}})
        self.assertEqual(response.status_code, 200, response.content)
        self.download(row, 'unsorted_0001.png', data)

    def test_nested_zip_frozen_names_and_original_native_master_bytes(self):
        project_response = self.post('/api/projects', {'op': 'createProject', 'name': 'Project'})
        self.assertEqual(project_response.status_code, 200, project_response.content)
        project = project_response.json()['project']['id']
        parent = self.folder('Parent', project=project)
        child = self.folder('Child', parent=parent, project=project)
        global_parent = self.folder('Global Parent')
        global_child = self.folder('Global Child', parent=global_parent)
        fixtures = [self.generation(child, project, 'video'), self.generation(child, project),
                    self.generation(global_child), self.generation()]
        identifier = self.post('/api/history/exports').json()['id']
        prefix = f'/api/history/exports/{identifier}'
        response = self.post(prefix + '/items', {'ids': [str(row.id) for row, _ in fixtures]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.post(prefix + '/finalize').status_code, 200)
        expected = ['Projects/Project/Parent/Child/Child_0001.mov',
                    'Projects/Project/Parent/Child/Child_0002.png',
                    'Global/Global Parent/Global Child/Global_Child_0001.png',
                    'Global/Unsorted/unsorted_0001.png']
        items = apps.get_model('exports', 'MediaExportItem')
        self.assertEqual(list(items.objects.filter(export_id=identifier).order_by('position').values_list('filename', flat=True)), expected)
        self.client.patch('/api/folders', {'id': parent, 'name': 'Changed'}, content_type='application/json')
        self.command('media_export_worker', '--once')
        job = apps.get_model('exports', 'MediaExport').objects.get(pk=identifier)
        self.assertEqual((job.status, job.manifest_version), ('ready', 3))
        response = self.client.get(prefix + '/download')
        self.assertEqual(response.status_code, 200)
        archive = ZipFile(io.BytesIO(b''.join(response.streaming_content)))
        self.assertEqual(archive.namelist(), expected)
        for name, (_, data) in zip(expected, fixtures):
            self.assertEqual(archive.read(name), data)
        response.close()
        apps.get_model('exports', 'MediaExport').objects.filter(pk=identifier).update(expires_at=1)
        self.command('cleanup_media_exports')
        response = self.client.get(prefix + '/download')
        self.assertEqual((response.status_code, response.json()), (410, {'error': 'EXPIRED'}))

    def test_export_api_admission_receipts_and_historical_refusal(self):
        result = self.scenario('export_admission', {'VEEVEE_RUNTIME_COMPONENT': 'api', 'VEEVEE_EXPORT_ADMISSION': '1'})
        self.assertEqual(result['status'], 201)
        self.assertEqual(result['receipt'], {'operation': 'GOAL4_PREVIEW_NEW_EXPORT_ONLY',
            'status': 'completed', 'expires_at': 0, 'result': {'id': result['id']}})
        self.assertEqual(result['refused'], [[404, {'error': 'EXPORT_NOT_FOUND'}], [409, {'error': 'Export cannot be queued.'}]])

    def test_export_worker_processes_only_admitted_jobs(self):
        result = self.scenario('export_admission', {'VEEVEE_RUNTIME_COMPONENT': 'api', 'VEEVEE_EXPORT_ADMISSION': '1'})
        admitted = result['id']
        historical = self.post('/api/history/exports').json()['id']
        row, _ = self.generation(kind='video')
        for identifier in (admitted, historical):
            self.assertEqual(self.post(f'/api/history/exports/{identifier}/items', {'ids': [str(row.id)]}).status_code, 200)
            self.assertEqual(self.post(f'/api/history/exports/{identifier}/finalize').status_code, 200)
        self.scenario('export_worker', {'VEEVEE_RUNTIME_COMPONENT': 'export', 'VEEVEE_EXPORT_ADMISSION': '1',
            'VEEVEE_MEDIA_BACKEND': 'filesystem', 'VEEVEE_MEDIA_ROOT': str(self.root)})
        jobs = apps.get_model('exports', 'MediaExport').objects
        self.assertEqual(jobs.get(pk=admitted).status, 'ready')
        self.assertEqual(jobs.get(pk=historical).status, 'queued')
