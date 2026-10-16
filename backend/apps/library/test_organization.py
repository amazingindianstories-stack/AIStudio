"""Managed-schema organization contracts and independent-transaction races."""
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from django.db import connections, transaction
from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests
from apps.generation.models import Generation
from apps.projects.models import Project
from .models import Folder, GenerationNaming, OrganizationIdempotencyKey, NamingCounter
from .services import folder_engine as service
from .services.idempotency import OrganizationError, fingerprint


class OrganizationTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = SettingsTests.setUp

    def post(self, body, path='/api/folders', **extra):
        return self.client.post(path, body, content_type='application/json', **extra)

    def error(self, code, call):
        with self.assertRaises(OrganizationError) as ctx:
            call()
        self.assertEqual(ctx.exception.code, code)

    def generation(self, **values):
        return Generation.objects.create(kind='image', status='done', prompt='fixture', model='fixture',
            aspect_ratio='1:1', created_at=1, updated_at=1, **values)

    def race(self, calls):
        barrier = Barrier(len(calls))
        def run(call):
            try:
                barrier.wait(timeout=10)
                try:
                    return call()
                except OrganizationError as exc:
                    return exc.code
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=len(calls)) as pool:
            return list(pool.map(run, calls))

    def test_auth_and_method_contracts(self):
        self.assertEqual(self.post({'name': 'Denied'}).status_code, 401)
        self.cookie()
        created = self.post({'name': '  Ｆｏｌｄｅｒ  ', 'color': ' BLUE '})
        self.assertEqual(created.status_code, 201)
        folder = created.json()['folder']
        self.assertEqual((folder['name'], folder['color'], folder['version']), ('Folder', 'blue', 1))
        self.assertNotIn('nameNormalized', folder)
        renamed = self.client.patch('/api/folders', {'id': folder['id'], 'name': 'Renamed', 'expectedVersion': 1}, content_type='application/json')
        self.assertEqual(renamed.json()['folder']['version'], 2)
        conflict = self.client.patch('/api/folders', {'id': folder['id'], 'name': 'Stale', 'expectedVersion': 1}, content_type='application/json')
        self.assertEqual((conflict.status_code, conflict.json()['code']), (409, 'VERSION_CONFLICT'))
        deleted = self.client.delete('/api/folders?id=' + folder['id'])
        self.assertEqual(deleted.json(), {'success': True, 'deletedFolderId': folder['id']})

    def test_color_palette_default_invalid_and_name_precedence(self):
        self.cookie()
        folder = service.create_folder(name='Color')
        for color in list(service.COLORS) + [None, '', 'default']:
            response = self.client.patch('/api/folders', {'id': folder['id'], 'color': color}, content_type='application/json')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['folder']['color'], color if color in service.COLORS else None)
        for invalid in ('cyan', 'Default', 0, False):
            self.assertEqual(self.post({'name': 'Invalid', 'color': invalid}).json()['code'], 'INVALID_COLOR')
        both = self.client.patch('/api/folders', {'id': folder['id'], 'name': 'Named', 'color': 'cyan'}, content_type='application/json')
        self.assertEqual(both.status_code, 200)
        self.assertIsNone(both.json()['folder']['color'])
        for destination in ({}, []):
            invalid = self.client.patch('/api/folders', {'id': folder['id'], 'color': 'red', 'destination': destination}, content_type='application/json')
            self.assertEqual(invalid.json(), {'error': 'Unknown destination type: undefined', 'code': 'INVALID_DESTINATION'})

    def test_normalization_and_utf16_length(self):
        service.create_folder(name='Ａbc')
        self.error('DUPLICATE_FOLDER_NAME', lambda: service.create_folder(name='abc'))
        self.assertEqual(service.normalize_name('\ufeffİ\ufeff'), ('İ', 'i\u0307'))
        self.assertEqual(service.normalize_name('😀' * 50)[0], '😀' * 50)
        for value in ('😀' * 51, 'a\x00b', '\u0085', '', None):
            self.error('INVALID_NAME', lambda value=value: service.create_folder(name=value))

    def test_payload_fingerprint_node_golden(self):
        # SHA256 of canonical JSON, independent known bytes from Node's contract.
        import hashlib
        self.assertEqual(fingerprint({'z': 'हिन्दी', 'a': {'b': 1, 'a': True}}), hashlib.sha256('{"a":{"a":true,"b":1},"z":"हिन्दी"}'.encode()).hexdigest())
        self.assertEqual(fingerprint({'10': 10, '2': 2, 'a': 1.0}), hashlib.sha256(b'{"2":2,"10":10,"a":1}').hexdigest())

    def test_persisted_unicode_duplicate_returns_domain_conflict(self):
        for name in ('À', 'İ'):
            service.create_folder(name=name)
            self.error('DUPLICATE_FOLDER_NAME', lambda: service.create_folder(name=name))

    def test_replay_actor_operation_payload_and_expiry(self):
        first = service.create_folder(name='Original', idempotency_key='key', actor_id='actor1')
        self.assertEqual(service.create_folder(name='Original', idempotency_key=' key ', actor_id='actor1'), first)
        self.error('IDEMPOTENCY_ACTOR_MISMATCH', lambda: service.create_folder(name='Original', idempotency_key='key', actor_id='actor2'))
        self.error('IDEMPOTENCY_PAYLOAD_MISMATCH', lambda: service.create_folder(name='Other', idempotency_key='key', actor_id='actor1'))
        self.error('IDEMPOTENCY_OPERATION_MISMATCH', lambda: service.delete_folder(folder_id=first['id'], idempotency_key='key', actor_id='actor1'))
        OrganizationIdempotencyKey.objects.filter(pk='key').update(expires_at=1)
        second = service.create_folder(name='Other', idempotency_key='key', actor_id=None)
        self.assertNotEqual(first['id'], second['id'])

    def test_failed_mutation_receipt_and_batch_roll_back(self):
        first, second = self.generation(), self.generation()
        self.error('VERSION_CONFLICT', lambda: service.move_generations(ids=[str(first.id), str(second.id)], destination={'type': 'global_root'}, expected_versions={str(second.id): 99}, idempotency_key='failed'))
        self.assertFalse(OrganizationIdempotencyKey.objects.filter(pk='failed').exists())
        self.assertEqual(list(Generation.objects.values_list('location_version', flat=True)), [1, 1])

    def test_concurrent_same_receipt_exactly_one_mutation(self):
        calls = [lambda: service.create_folder(name='Only once', idempotency_key='same')] * 6
        results = self.race(calls)
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(Folder.objects.count(), 1)
        self.assertEqual(OrganizationIdempotencyKey.objects.count(), 1)

    def test_concurrent_sibling_collision(self):
        results = self.race([lambda: service.create_folder(name='Ｓame'), lambda: service.create_folder(name='same')])
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn('DUPLICATE_FOLDER_NAME', results)
        self.assertEqual(Folder.objects.count(), 1)

    def test_cross_scope_subtree_and_generation_version_naming(self):
        project = Project.objects.create(name='Target', created_at=1, updated_at=1)
        root = service.create_folder(name='Root')
        child = service.create_folder(name='Child', parent_id=root['id'])
        gen = self.generation(folder_id=child['id'])
        original = GenerationNaming.objects.get(generation=gen)
        moved = service.move_folder(folder_id=root['id'], destination={'type': 'project_root', 'projectId': str(project.id)}, expected_version=1)
        self.assertTrue(moved['scopeChanged'])
        self.assertEqual(moved['subtreeFolderCount'], 2)
        child_row = Folder.objects.get(pk=child['id'])
        gen.refresh_from_db()
        after = GenerationNaming.objects.get(generation=gen)
        self.assertEqual((child_row.project_id, child_row.version, gen.project_id, gen.location_version), (project.id, 2, project.id, 2))
        self.assertEqual((original.namespace, original.sequence), (after.namespace, after.sequence))

    def test_cycles_self_move_depth_and_restricted_delete(self):
        root = service.create_folder(name='Root')
        child = service.create_folder(name='Child', parent_id=root['id'])
        self.error('CANNOT_MOVE_INTO_SELF', lambda: service.move_folder(folder_id=root['id'], destination={'type': 'folder', 'folderId': root['id']}))
        self.error('CYCLE_DETECTED', lambda: service.move_folder(folder_id=root['id'], destination={'type': 'folder', 'folderId': child['id']}))
        self.error('FOLDER_NOT_EMPTY', lambda: service.delete_folder(folder_id=root['id']))
        with patch.dict('os.environ', {'MAX_NESTING_DEPTH': '2'}):
            self.error('EXCEEDS_MAX_DEPTH', lambda: service.create_folder(name='Too deep', parent_id=child['id']))
        self.generation(folder_id=child['id'])
        self.error('FOLDER_NOT_EMPTY', lambda: service.delete_folder(folder_id=child['id']))

    def test_concurrent_opposite_moves_cannot_make_cycle(self):
        one, two = service.create_folder(name='One'), service.create_folder(name='Two')
        results = self.race([
            lambda: service.move_folder(folder_id=one['id'], destination={'type': 'folder', 'folderId': two['id']}),
            lambda: service.move_folder(folder_id=two['id'], destination={'type': 'folder', 'folderId': one['id']})])
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn('CYCLE_DETECTED', results)

    def test_concurrent_optimistic_rename_single_winner(self):
        folder = service.create_folder(name='Name')
        results = self.race([lambda: service.rename_folder(folder_id=folder['id'], name='One', expected_version=1), lambda: service.rename_folder(folder_id=folder['id'], name='Two', expected_version=1)])
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn('VERSION_CONFLICT', results)
        self.assertEqual(Folder.objects.get(pk=folder['id']).version, 2)

    def test_moves_allocate_unique_names_preserve_same_namespace_and_receipt(self):
        target = service.create_folder(name='Target')
        gens = [self.generation() for _ in range(8)]
        results = self.race([lambda gen=gen: service.move_generations(ids=[str(gen.id)], destination={'type': 'folder', 'folderId': target['id']}, idempotency_key=str(gen.id)) for gen in gens])
        self.assertEqual(sum(r['reallocatedNamingCount'] for r in results), 8)
        self.assertEqual(sorted(GenerationNaming.objects.filter(namespace='folder:' + target['id']).values_list('sequence', flat=True)), list(range(1, 9)))
        same = service.move_generations(ids=[str(gens[0].id)], destination={'type': 'folder', 'folderId': target['id']})
        self.assertEqual((same['reallocatedNamingCount'], same['preservedNamingCount']), (0, 1))
        replay = service.move_generations(ids=[str(gens[0].id)], destination={'type': 'folder', 'folderId': target['id']}, idempotency_key=str(gens[0].id))
        self.assertEqual(replay, results[0])
        self.assertEqual(NamingCounter.objects.get(namespace='folder:' + target['id']).next_sequence, 9)

    def test_parent_scope_inheritance_mismatch_and_malformed_http(self):
        project = Project.objects.create(name='P', created_at=1, updated_at=1)
        parent = service.create_folder(name='P folder', project_id=str(project.id))
        child = service.create_folder(name='Child', parent_id=parent['id'])
        self.assertEqual(child['projectId'], str(project.id))
        self.error('PROJECT_MISMATCH', lambda: service.rename_folder(folder_id=child['id'], name='New', project_id=None))
        self.cookie()
        self.assertEqual(self.client.post('/api/folders', '{', content_type='application/json').json()['code'], 'INVALID_NAME')
        self.assertEqual(self.client.patch('/api/folders', {}, content_type='application/json').status_code, 400)

    def test_atomic_outer_transaction_rolls_back_all_services(self):
        with self.assertRaises(RuntimeError):
            with transaction.atomic():
                service.create_folder(name='Rollback', idempotency_key='rollback')
                raise RuntimeError('abort')
        self.assertFalse(Folder.objects.exists())
        self.assertFalse(OrganizationIdempotencyKey.objects.exists())


    def test_concurrent_project_delete_and_folder_create_never_orphans(self):
        from apps.projects.services.projects import delete_project
        project = Project.objects.create(name='P', created_at=1, updated_at=1)
        results = self.race([
            lambda: delete_project(str(project.id)),
            lambda: service.create_folder(name='Child', project_id=str(project.id))])
        if Project.objects.filter(pk=project.id).exists():
            self.assertIn('PROJECT_NOT_EMPTY', results)
            self.assertEqual(Folder.objects.filter(project_id=project.id).count(), 1)
        else:
            self.assertIn('PROJECT_NOT_FOUND', results)
            self.assertFalse(Folder.objects.filter(project_id=project.id).exists())
