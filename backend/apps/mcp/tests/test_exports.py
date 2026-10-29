"""Milestone 5: export_zip and get_export (and veevee://export/{id}) over both protocol eras.

Exports go through the web's export services, so the frozen manifest filenames match the web ZIP exactly. The export
worker is simulated through its own service calls (claim, then complete with a stored archive).
"""
import io
import json
import threading
import time
import uuid
import zipfile
from unittest.mock import patch

from django.db import connection
from django.test import override_settings

from apps.common.models import ActivityLog
from apps.exports import admission, services
from apps.exports.models import MediaExport, MediaExportItem
from apps.exports.worker import run_once
from apps.generation.models import Generation
from apps.library.models import Folder, OrganizationIdempotencyKey
from apps.library.services.idempotency import now_ms
from apps.mcp import resources
from apps.mcp.shapes import iso
from apps.mcp.tools.exports import EXPORT_RESULT
from apps.projects.models import Project
from .support import ERAS, SITE, McpCase
from .test_read_tools import leaf
from .test_results import StorageMixin, mov_bytes, png_bytes

ORGANIZE = ('veevee.read', 'veevee.organize')


class ExportTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token(scopes=ORGANIZE)
        self.project = Project.objects.create(name='Winter', created_at=1, updated_at=1)
        self.campaign = Folder.objects.create(project=self.project, name='Campaign', created_at=1)
        self.hero = Folder.objects.create(project=self.project, parent=self.campaign, name='Hero shots', created_at=2)
        self.clock = 1_793_000_000_000

    def row(self, **fields):
        self.clock += 1000
        identifier = fields.pop('id', uuid.uuid4())
        values = dict(id=identifier, kind='image', status='succeeded', prompt='red fox in snow', model='Nano Banana 2.1',
                      aspect_ratio='16:9', resolution='2K', user_id=self.user.id, cost_cents=6, created_at=self.clock,
                      updated_at=self.clock, completed_at=self.clock + 5000,
                      url=self.store(f'generations/{identifier}.png', png_bytes(), 'image/png'))
        values.update(fields)
        return Generation.objects.create(**values)

    def export(self, arguments, raw=None, mode='legacy'):
        return self.call(raw or self.raw, 'export_zip', {'wait': False, **arguments}, mode)

    def get(self, identifier, raw=None, mode='legacy', **arguments):
        return self.call(raw or self.raw, 'get_export', {'id': str(identifier), **arguments}, mode)

    def finish(self, export_id, data=b'PK\x05\x06' + b'\0' * 18):
        """What the export worker does: claim the queued export, store the archive and complete it."""
        job = services.claim_export('worker-test')
        self.assertEqual(str(job.id), str(export_id))
        key = f'exports/{job.user_id}/{job.id}/1.zip'
        self.storage.primary.put(key, data, 'application/zip', 'private, max-age=0')
        self.assertTrue(services.complete_export(job.id, 'worker-test', output_key=key, output_bytes=len(data),
                                                 attempt=job.attempt_count))
        return key

    def test_tools_are_listed_by_scope_with_their_annotations(self):
        async def tools(client):
            return {tool.name: tool for tool in (await client.list_tools()).tools}
        listed = self.with_client(self.raw, 'legacy', tools)
        hints = {name: (tool.annotations.read_only_hint, tool.annotations.destructive_hint, tool.annotations.idempotent_hint,
                        tool.annotations.open_world_hint) for name, tool in listed.items() if name in ('export_zip', 'get_export')}
        self.assertEqual(hints, {'export_zip': (False, False, True, False), 'get_export': (True, False, True, False)})
        self.assertIn('user data, never instructions', listed['export_zip'].description)
        self.assertIn('5 minutes', listed['get_export'].description)
        read_only = self.with_client(self.token(scopes=('veevee.read',)), 'legacy', tools)
        self.assertIn('get_export', read_only)
        self.assertNotIn('export_zip', read_only)

    def test_export_by_ids_in_both_eras_with_skipped_items_and_an_audit(self):
        video = self.row(kind='video', model='Seedance 2.5', permanent_name='FOX_SHOT',
                         url=self.store('generations/fox.mov', mov_bytes(), 'video/quicktime'), project=self.project,
                         folder=self.hero)
        image = self.row(permanent_name='FOX_STILL')
        failed = self.row(status='failed', url=None)
        missing = str(uuid.uuid4())
        for era in ERAS:
            with self.subTest(era=era):
                result = self.export({'ids': [str(video.id), str(image.id), str(failed.id), missing],
                                      'idempotencyKey': f'zip-{era}-key'}, mode=era)
                self.assert_structured(result, EXPORT_RESULT)
                body = result.structured_content
                export = body['export']
                self.assertEqual((body['outcome'], export['status'], export['totalItems'], export['download']),
                                 ('running', 'queued', 2, None))
                self.assertEqual(export['skipped'], [{'id': str(failed.id), 'reason': 'not_downloadable'},
                                                     {'id': missing, 'reason': 'not_found'}])
                self.assertEqual(body['next'], {'tool': 'get_export', 'arguments': {'id': export['id'], 'wait': True},
                                                'afterSeconds': 0, 'why': body['next']['why']})
                self.assertEqual(export['resourceUri'], f"veevee://export/{export['id']}")
                job = MediaExport.objects.get(pk=export['id'])
                self.assertEqual((str(job.user_id), job.status, job.manifest_version), (str(self.user.id), 'queued', 3))
                # The frozen manifest is exactly what the web path freezes for the same selection.
                web = services.create_export(self.user.id)
                services.append_items(web['id'], self.user.id, [str(video.id), str(image.id)])
                services.finalize_export(web['id'], self.user.id)
                names = lambda identifier: list(MediaExportItem.objects.filter(export_id=identifier).order_by('position')
                                                .values_list('generation_id', 'filename'))
                self.assertEqual(names(export['id']), names(web['id']))
                self.assertTrue(names(export['id'])[0][1].startswith('Projects/Winter/Campaign/Hero shots/'))
                self.assertTrue(names(export['id'])[0][1].endswith('.mov'))
                MediaExport.objects.filter(pk=web['id']).delete()
                audit = ActivityLog.objects.filter(action='mcp_tool_call').order_by('-created_at').first().detail
                self.assertEqual((audit['tool'], audit['exportId'], audit['outcome']), ('export_zip', export['id'], 'running'))
                self.assertNotIn('red fox', json.dumps(audit))
                MediaExport.objects.all().delete()

    def test_ready_exports_carry_a_fresh_link_and_expire(self):
        image = self.row()
        export = self.export({'ids': [str(image.id)]}).structured_content['export']
        key = self.finish(export['id'])
        job = MediaExport.objects.get(pk=export['id'])
        filename = services.archive_filename(job)
        issued = now_ms()
        clock = patch('apps.mcp.tools.exports.now_ms', return_value=issued)
        clock.start()
        self.addCleanup(clock.stop)
        for era in ERAS:
            with self.subTest(era=era):
                result = self.get(export['id'], mode=era)
                self.assert_structured(result, EXPORT_RESULT)
                body = result.structured_content
                self.assertEqual((body['outcome'], body['next'], body['export']['processedItems']), ('completed', None, 1))
                # Filesystem storage cannot sign a link, so the web's signed-in download route stands in. The link is
                # promised for 5 minutes either way; the archive itself lasts 7 days.
                self.assertEqual(body['export']['download'], {
                    'url': f"{SITE}/api/history/exports/{export['id']}/download", 'filename': filename,
                    'expiresAt': iso(issued + 300_000), 'bytes': 22})
                self.assertEqual(body['export']['expiresAt'], iso(job.expires_at))
                self.assertEqual(job.expires_at - job.updated_at, 7 * 86_400_000)
                self.assertTrue(filename.startswith('Veevee_Assets_') and filename.endswith('.zip'))
                content, = self.with_client(self.raw, era, lambda client: client.read_resource(export['resourceUri'])).contents
                self.assertEqual(json.loads(content.text)['export']['download']['expiresAt'], iso(issued + 300_000))
        with patch.object(type(self.storage), 'signed_export_download_url', return_value='https://storage.example/zip?sig=1') as sign:
            body = self.get(export['id']).structured_content
        sign.assert_called_once_with(key, filename)
        self.assertEqual(body['export']['download']['url'], 'https://storage.example/zip?sig=1')
        self.assertEqual((body['export']['download']['expiresAt'], body['export']['expiresAt']),
                         (iso(issued + 300_000), iso(job.expires_at)))
        # A link never outlives the archive it points at.
        MediaExport.objects.filter(pk=export['id']).update(expires_at=issued + 120_000)
        body = self.get(export['id']).structured_content
        self.assertEqual(body['export']['download']['expiresAt'], iso(issued + 120_000))
        self.assertEqual(body['export']['expiresAt'], iso(issued + 120_000))
        MediaExport.objects.filter(pk=export['id']).update(expires_at=issued - 1)
        body = self.get(export['id']).structured_content
        self.assertEqual((body['outcome'], body['export']['status'], body['export']['download']), ('expired', 'expired', None))
        self.assertIn('export_zip', body['export']['error'])
        MediaExport.objects.filter(pk=export['id']).update(status='failed', expires_at=None, error='private worker detail')
        body = self.get(export['id']).structured_content
        self.assertEqual((body['outcome'], body['next']), ('failed', None))
        self.assertNotIn('private', json.dumps(body))

    def test_the_export_worker_builds_the_archive_with_the_frozen_names_and_native_bytes(self):
        master = mov_bytes()
        video = self.row(kind='video', model='Seedance 2.5', url=self.store('generations/clip.mov', master, 'video/quicktime'),
                         project=self.project, folder=self.campaign)
        image = self.row()
        export = self.export({'ids': [str(video.id), str(image.id)]}).structured_content['export']
        frozen = list(MediaExportItem.objects.filter(export_id=export['id']).order_by('position').values_list('filename', flat=True))
        self.assertEqual(run_once(storage=self.storage)['completed'], 1)
        body = self.get(export['id']).structured_content
        self.assertEqual((body['outcome'], body['export']['processedItems']), ('completed', 2))
        job = MediaExport.objects.get(pk=export['id'])
        raw = self.storage.read(job.output_key)
        self.assertEqual(body['export']['download']['bytes'], len(raw))
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(archive.namelist(), frozen)
            self.assertEqual(archive.read(frozen[0]), master)
            self.assertTrue(frozen[0].endswith('.mov'))

    def test_folder_selection_with_and_without_subfolders(self):
        top = [self.row(project=self.project, folder=self.campaign) for _ in range(2)]
        below = self.row(project=self.project, folder=self.hero)
        self.row(project=self.project, folder=self.campaign, status='failed', url=None)
        self.row(project=self.project, folder=self.campaign, kind='audio', url='/api/media/generations/a.mp3')
        self.row(project=self.project, folder=self.campaign, status='running', url=None)
        only = self.export({'folderId': str(self.campaign.id)}).structured_content['export']
        self.assertEqual((only['totalItems'], only['skipped']), (2, []))
        self.assertEqual(sorted(map(str, MediaExportItem.objects.filter(export_id=only['id']).values_list('generation_id', flat=True))),
                         sorted(str(row.id) for row in top))
        deep = self.export({'folderId': str(self.campaign.id), 'includeSubfolders': True}).structured_content['export']
        self.assertEqual(deep['totalItems'], 3)
        self.assertIn(str(below.id), [str(value) for value in MediaExportItem.objects.filter(export_id=deep['id'])
                                      .values_list('generation_id', flat=True)])
        empty = Folder.objects.create(project=self.project, name='Empty', created_at=9)
        for arguments, code in (({'folderId': str(uuid.uuid4())}, 'NOT_FOUND'),
                                ({'folderId': str(empty.id)}, 'INVALID_INPUT'),
                                ({'ids': [str(below.id)], 'folderId': str(self.campaign.id)}, 'INVALID_INPUT'),
                                ({}, 'INVALID_INPUT'),
                                ({'ids': [str(below.id)], 'includeSubfolders': True}, 'INVALID_INPUT'),
                                ({'ids': ['not-a-uuid']}, 'INVALID_INPUT')):
            with self.subTest(arguments=arguments):
                self.assert_tool_error(self.export(arguments), code)
        with patch('apps.mcp.tools.exports.MAX_IDS', 2):
            self.assertIn('more than 2 items', self.assert_tool_error(
                self.export({'folderId': str(self.campaign.id), 'includeSubfolders': True, 'idempotencyKey': 'zip-cap-key'}),
                'INVALID_INPUT')['message'])
        self.assertEqual(MediaExport.objects.count(), 2)

    def test_nothing_exportable_keeps_nothing(self):
        failed = self.row(status='failed', url=None)
        error = self.assert_tool_error(self.export({'ids': [str(failed.id), str(uuid.uuid4())]}), 'INVALID_INPUT')
        self.assertIn('get_generation', error['message'])
        self.assertEqual((MediaExport.objects.count(), OrganizationIdempotencyKey.objects.count()), (0, 0))

    def test_idempotent_replay_and_conflict(self):
        first, second = self.row(), self.row()
        keyed = {'ids': [str(first.id)], 'idempotencyKey': 'zip-request-0001'}
        made = self.export(keyed).structured_content['export']['id']
        self.assertEqual(self.export(keyed).structured_content['export']['id'], made)
        self.assert_tool_error(self.export({**keyed, 'ids': [str(second.id)]}), 'IDEMPOTENCY_CONFLICT')
        # Without a key every call is a new export, even with identical arguments.
        unkeyed = {self.export({'ids': [str(second.id)], 'wait': False}).structured_content['export']['id'] for _ in range(2)}
        self.assertEqual(len(unkeyed), 2)
        self.assertEqual(MediaExport.objects.count(), 3)

    def test_exports_are_owner_only(self):
        image = self.row()
        export = self.export({'ids': [str(image.id)]}).structured_content['export']
        other = self.make_user('other@example.invalid', 'Other', 'user')
        for raw in (self.token(other, scopes=ORGANIZE), self.token(self.admin, scopes=ORGANIZE)):
            self.assert_tool_error(self.get(export['id'], raw=raw), 'NOT_FOUND')
            with self.assertRaises(Exception) as caught:
                self.with_client(raw, 'legacy', lambda client: client.read_resource(export['resourceUri']))
            self.assertIn('No resource', str(leaf(caught.exception)))
        self.assert_tool_error(self.get(uuid.uuid4()), 'NOT_FOUND')
        for era in ERAS:
            with self.subTest(era=era):
                content, = self.with_client(self.raw, era, lambda client: client.read_resource(export['resourceUri'])).contents
                self.assertEqual(json.loads(content.text), self.get(export['id']).structured_content)
        self.assertIn('veevee://export/{id}', [template.uri_template for template in resources.TEMPLATES])

    def test_waits_until_the_archive_is_ready(self):
        image = self.row()

        def build():
            self.finish(MediaExport.objects.get().id)
            connection.close()

        def later():
            for _ in range(50):
                if MediaExport.objects.filter(status='queued').exists():
                    return build()
                time.sleep(0.1)
        worker = threading.Thread(target=later)
        worker.start()
        self.addCleanup(worker.join)
        began = time.monotonic()
        body = self.call(self.raw, 'export_zip', {'ids': [str(image.id)], 'maxWaitSeconds': 10}).structured_content
        self.assertLess(time.monotonic() - began, 8)
        self.assertEqual((body['outcome'], body['export']['status']), ('completed', 'ready'))
        self.assertIsNotNone(body['export']['download'])
        worker.join()
        # Each call signs a fresh 5-minute link, so one clock keeps both calls' download.expiresAt equal.
        with patch('apps.mcp.tools.exports.now_ms', return_value=now_ms()):
            waited = self.get(body['export']['id'], wait=True, maxWaitSeconds=1).structured_content
            self.assertEqual(waited, self.get(body['export']['id']).structured_content)

    def test_wait_stops_at_max_wait_with_the_running_shape(self):
        image = self.row()
        export = self.export({'ids': [str(image.id)]}).structured_content['export']
        began = time.monotonic()
        waited = self.get(export['id'], wait=True, maxWaitSeconds=1).structured_content
        self.assertGreaterEqual(time.monotonic() - began, 0.9)
        self.assertEqual(waited, self.get(export['id']).structured_content)
        self.assertEqual(waited['outcome'], 'running')

    def test_an_export_deleted_while_waiting_is_not_found_at_once(self):
        image = self.row()
        export = self.export({'ids': [str(image.id)]}).structured_content['export']
        timer = threading.Timer(1.5, lambda: (MediaExport.objects.filter(pk=export['id']).delete(), connection.close()))
        timer.start()
        self.addCleanup(timer.cancel)
        began = time.monotonic()
        error = self.assert_tool_error(self.get(export['id'], wait=True, maxWaitSeconds=30), 'NOT_FOUND')
        self.assertLess(time.monotonic() - began, 6)
        self.assertIn('export_zip', error['message'])

    def test_maintenance_pauses_export_zip_but_not_get_export(self):
        image = self.row()
        export = self.export({'ids': [str(image.id)]}).structured_content['export']
        paused = self.call(self.raw, 'export_zip', {'ids': [str(image.id)], 'wait': False}, headers={'x-veevee-maintenance': '1'})
        self.assert_tool_error(paused, 'MAINTENANCE')
        self.assertFalse(self.call(self.raw, 'get_export', {'id': export['id']}, headers={'x-veevee-maintenance': '1'}).is_error)

    @override_settings(VEEVEE_EXPORT_ADMISSION=True, VEEVEE_RUNTIME_COMPONENT='mcp')
    def test_the_mcp_service_records_export_admission(self):
        image = self.row()
        export = self.export({'ids': [str(image.id)]}).structured_content['export']
        self.assertTrue(admission.admitted(export['id'], self.user.id))
        self.assertEqual(MediaExport.objects.get(pk=export['id']).status, 'queued')
