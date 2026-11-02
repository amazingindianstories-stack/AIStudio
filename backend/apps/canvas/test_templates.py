"""Board templates and blueprints: the library, custom templates, access levels, insert helpers, usage counts."""
import json
from unittest.mock import patch
from uuid import uuid4
from django.db import connection
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.media.storage import MemoryAdapter, StorageService
from apps.projects.models import Project, ProjectMember
from . import template_catalog, templates
from .models import Blueprint, BoardTemplate, CanvasBoard
from .serialization import validate_state

PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
LAYERED_SETTINGS = {'background': '#112233', 'startView': {'x': 40, 'y': 50, 'zoom': 2},
                    'layers': [{'id': 'notes', 'name': 'Notes'}, {'id': 'base', 'name': 'Base', 'locked': True}]}


def make_user(name, role='user'):
    return User.objects.create(id=uuid4(), email=f'{name}@example.invalid', name=name, role=role,
                               password_hash='x', password_salt='', created_at=1, is_active=True)


def sticky(identifier, text='Note', **extra):
    return {'id': identifier, 'type': 'sticky', 'x': 0, 'y': 0, 'w': 140, 'h': 140, 'parentId': None, 'groupId': None,
            'text': text, 'fill': '#fff59d', 'fontSize': 16, 'color': '#000000', **extra}


class CatalogTests(SimpleTestCase):
    def test_every_shipped_template_survives_board_validation(self):
        for item in template_catalog.TEMPLATES:
            graph = item['graph']
            self.assertTrue(graph['nodes'], item['slug'])
            self.assertEqual(validate_state({**graph, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})['nodes'], graph['nodes'], item['slug'])
            self.assertIn(item['category'], templates.CATEGORIES)

    def test_every_blueprint_board_names_a_shipped_template(self):
        for item in template_catalog.BLUEPRINTS:
            for board in item['boards']:
                self.assertIsNotNone(template_catalog.template(board['template']))


class GraphHelperTests(SimpleTestCase):
    graph = {'version': 1, 'nodes': [
        {**sticky('a', 'First', tagIds=['t1'], reactions={'+1': ['u1']}, createdBy='u1', textBy='u1'), 'groupId': 'g'},
        {**sticky('b', 'Second'), 'groupId': 'g', 'parentId': 'a'},
        {'id': 'f', 'type': 'frame', 'x': 0, 'y': 0, 'w': 500, 'h': 400, 'parentId': None, 'groupId': None, 'name': 'Frame',
         'fill': 'transparent', 'stroke': '#000000'},
        {'id': 't', 'type': 'text', 'x': 0, 'y': 0, 'w': 100, 'h': 40, 'parentId': None, 'groupId': None, 'text': 'Heading',
         'fontSize': 16, 'align': 'left', 'color': '#000000'},
    ], 'connectors': [{'id': 'c', 'from': {'nodeId': 'a', 'anchor': 'auto'}, 'to': {'nodeId': 'b', 'anchor': 'auto'},
                       'kind': 'arrow', 'stroke': '#000000', 'strokeWidth': 2}],
        'tags': [{'id': 't1', 'name': 'Idea', 'color': '#22c55e'}]}

    def test_instantiate_gives_fresh_ids_and_remaps_every_reference(self):
        board = templates.instantiate(validate_state(self.graph))
        old = {'a', 'b', 'f', 't', 'c', 'g'}
        ids = {item['id'] for item in board['nodes']}
        self.assertFalse(ids & old)
        a, b = board['nodes'][0], board['nodes'][1]
        self.assertEqual(b['parentId'], a['id'])
        self.assertEqual(a['groupId'], b['groupId'])
        self.assertNotEqual(a['groupId'], 'g')
        connector = board['connectors'][0]
        self.assertEqual((connector['from']['nodeId'], connector['to']['nodeId']), (a['id'], b['id']))
        self.assertNotIn(connector['id'], old)
        self.assertEqual(board['tags'], self.graph['tags'])

    def test_instantiating_twice_never_shares_an_id(self):
        graph = validate_state(self.graph)
        first, second = templates.instantiate(graph), templates.instantiate(graph)
        self.assertFalse({n['id'] for n in first['nodes']} & {n['id'] for n in second['nodes']})

    def test_blank_clears_stickies_and_keeps_headings_and_frames(self):
        board = templates.instantiate(validate_state(self.graph), blank=True)
        by_type = {item['type']: item for item in board['nodes']}
        self.assertEqual(by_type['sticky']['text'], '')
        self.assertNotIn('tagIds', by_type['sticky'])
        self.assertNotIn('reactions', by_type['sticky'])
        self.assertEqual(by_type['text']['text'], 'Heading')
        self.assertEqual(by_type['frame']['name'], 'Frame')
        self.assertEqual(by_type['sticky']['fill'], '#fff59d')

    def test_instantiate_keeps_background_layers_and_layer_locks_but_not_the_start_view(self):
        graph = templates.snapshot({**self.graph, 'settings': LAYERED_SETTINGS,
                                    'nodes': [{**self.graph['nodes'][0], 'layerId': 'base'}, {**self.graph['nodes'][2], 'layerId': 'notes'}]})
        for blank in (False, True):
            board = templates.instantiate(graph, blank=blank)
            self.assertEqual(board['settings'], {'background': '#112233', 'layers': LAYERED_SETTINGS['layers']})
            self.assertEqual([item['layerId'] for item in board['nodes']], ['base', 'notes'])

    def test_snapshot_drops_stamps_and_viewport(self):
        stored = templates.snapshot({**self.graph, 'viewport': {'x': 5, 'y': 5, 'zoom': 2}})
        self.assertNotIn('viewport', stored)
        self.assertFalse(any('createdBy' in item or 'textBy' in item for item in stored['nodes']))

    def test_preview_is_a_few_normalized_boxes(self):
        preview = templates.preview_of(validate_state(self.graph))
        self.assertEqual(max(preview['w'], preview['h']), templates.PREVIEW_SPAN)
        self.assertEqual(preview['rects'][0][4], 'f')
        self.assertLessEqual(len(preview['rects']), templates.PREVIEW_RECTS)
        self.assertEqual(templates.preview_of({'nodes': [], 'connectors': []})['rects'], [])


@override_settings(ROOT_URLCONF='config.urls')
class TemplateApiTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.owner, self.mate = make_user('owner'), make_user('mate')
        self.other = make_user('other')
        self.admin = make_user('admin', role='admin')
        Project.objects.create(id=PROJECT, name='Project', created_by=self.owner.id, created_at=1, updated_at=1)
        ProjectMember.objects.create(project_id=PROJECT, user_id=self.owner.id, role='owner', created_at=1, updated_at=1)
        self.board = CanvasBoard.objects.create(
            id=uuid4(), project_id=PROJECT, name='Board', created_by=self.owner.id, created_at=1, updated_at=1,
            data={'version': 1, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}, 'nodes': [sticky('s1', 'Hello', createdBy='x')], 'connectors': []})

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def send(self, method, path, data=None):
        if method == 'get':
            return self.client.get(path)
        return getattr(self.client, method)(path, data=json.dumps(data if data is not None else {}), content_type='application/json')

    def make(self, scope='personal', **extra):
        """The owner's template; only an admin shares one with everyone, so an admin publishes those."""
        self.as_user(self.owner)
        reply = self.send('post', '/api/canvas-templates', {'name': 'Mine', 'boardId': str(self.board.id),
                                                             'scope': 'personal' if scope == 'everyone' else scope,
                                                             'projectId': PROJECT, **extra})
        self.assertEqual(reply.status_code, 201, reply.content)
        entry = reply.json()['template']
        if scope == 'everyone':
            entry = self.publish(entry['id'])
        return entry

    def publish(self, ref):
        self.as_user(self.admin)
        reply = self.send('patch', f'/api/canvas-templates/{ref}', {'scope': 'everyone'})
        self.assertEqual(reply.status_code, 200, reply.content)
        return reply.json()['template']

    def listed(self, user, project=PROJECT):
        self.as_user(user)
        return {item['id']: item for item in self.send('get', f'/api/canvas-templates?projectId={project}').json()['templates']}

    def test_the_library_lists_shipped_templates_with_categories(self):
        self.as_user(self.mate)
        reply = self.send('get', '/api/canvas-templates').json()
        refs = {item['id'] for item in reply['templates']}
        self.assertIn('builtin:swot', refs)
        self.assertIn('image-creation', reply['categories'])
        self.assertFalse(reply['isAdmin'])

    def test_requires_a_session(self):
        self.client.cookies.clear()
        self.assertEqual(self.send('get', '/api/canvas-templates').status_code, 401)
        self.assertEqual(self.send('post', '/api/canvas-templates', {}).status_code, 401)

    def test_save_a_whole_board_keeps_a_stamp_free_copy(self):
        entry = self.make()
        row = BoardTemplate.objects.get(pk=entry['id'])
        self.assertEqual(row.node_count, 1)
        self.assertNotIn('createdBy', row.graph['nodes'][0])
        self.assertTrue(row.preview['rects'])
        # Editing the source board later never changes the template.
        CanvasBoard.objects.filter(pk=self.board.id).update(data={'version': 1, 'nodes': [], 'connectors': []})
        self.assertEqual(BoardTemplate.objects.get(pk=entry['id']).node_count, 1)

    def test_save_a_selection_graph(self):
        self.as_user(self.owner)
        reply = self.send('post', '/api/canvas-templates', {'name': 'Pair', 'boardId': str(self.board.id),
                                                             'graph': {'nodes': [sticky('x'), sticky('y')], 'connectors': []}})
        self.assertEqual(reply.status_code, 201)
        self.assertEqual(reply.json()['template']['nodeCount'], 2)

    def test_empty_or_unnamed_templates_are_refused(self):
        self.as_user(self.owner)
        board = str(self.board.id)
        self.assertEqual(self.send('post', '/api/canvas-templates', {'name': 'Empty', 'boardId': board, 'graph': {'nodes': []}}).status_code, 400)
        self.assertEqual(self.send('post', '/api/canvas-templates', {'name': ' ', 'boardId': board, 'graph': {'nodes': [sticky('x')]}}).status_code, 400)
        self.assertEqual(self.send('post', '/api/canvas-templates', {'name': 'X', 'category': 'nope', 'boardId': board, 'graph': {'nodes': [sticky('x')]}}).status_code, 400)

    def test_saving_a_board_needs_edit_rights_on_it(self):
        self.as_user(self.mate)
        for role in ('view', 'comment'):
            CanvasBoard.objects.filter(pk=self.board.id).update(team_role=role)
            reply = self.send('post', '/api/canvas-templates', {'name': 'T', 'boardId': str(self.board.id)})
            self.assertEqual((reply.status_code, reply.json()), (403, {'error': 'FORBIDDEN'}))
        self.assertFalse(BoardTemplate.objects.exists())
        self.assertEqual(self.send('post', '/api/canvas-templates', {'name': 'T', 'boardId': str(uuid4())}).status_code, 404)
        CanvasBoard.objects.filter(pk=self.board.id).update(team_role='edit')
        self.assertEqual(self.send('post', '/api/canvas-templates', {'name': 'T', 'boardId': str(self.board.id)}).status_code, 201)

    def test_saving_a_selection_needs_edit_rights_on_its_board(self):
        selection = {'nodes': [sticky('s1', 'Hello')], 'connectors': []}
        self.as_user(self.mate)
        reply = self.send('post', '/api/canvas-templates', {'name': 'S', 'graph': selection})
        self.assertEqual(reply.status_code, 400)
        CanvasBoard.objects.filter(pk=self.board.id).update(team_role='view')
        reply = self.send('post', '/api/canvas-templates', {'name': 'S', 'boardId': str(self.board.id), 'graph': selection})
        self.assertEqual((reply.status_code, reply.json()), (403, {'error': 'FORBIDDEN'}))
        self.assertFalse(BoardTemplate.objects.exists())
        CanvasBoard.objects.filter(pk=self.board.id).update(team_role='edit')
        reply = self.send('post', '/api/canvas-templates', {'name': 'S', 'boardId': str(self.board.id), 'graph': selection})
        self.assertEqual(reply.status_code, 201, reply.content)

    def test_only_an_admin_shares_a_template_with_everyone(self):
        self.as_user(self.owner)
        refused = self.send('post', '/api/canvas-templates', {'name': 'All', 'boardId': str(self.board.id), 'scope': 'everyone'})
        self.assertEqual((refused.status_code, refused.json()), (403, {'error': 'FORBIDDEN'}))
        self.assertFalse(BoardTemplate.objects.exists())
        mine = self.make('personal')
        self.as_user(self.owner)
        self.assertEqual(self.send('patch', f'/api/canvas-templates/{mine["id"]}', {'scope': 'everyone'}).status_code, 403)
        self.assertEqual(BoardTemplate.objects.get(pk=mine['id']).scope, 'personal')
        # Editing other details of a template an admin shared leaves its access alone.
        self.publish(mine['id'])
        self.as_user(self.owner)
        self.assertEqual(self.send('patch', f'/api/canvas-templates/{mine["id"]}', {'description': 'Shared'}).status_code, 200)
        self.as_user(self.admin)
        reply = self.send('post', '/api/canvas-templates', {'name': 'All', 'boardId': str(self.board.id), 'scope': 'everyone'})
        self.assertEqual(reply.status_code, 201, reply.content)

    def test_project_access_needs_membership_of_that_project(self):
        selection = {'nodes': [sticky('x')], 'connectors': []}
        CanvasBoard.objects.filter(pk=self.board.id).update(team_role='edit')
        self.as_user(self.mate)
        reply = self.send('post', '/api/canvas-templates', {'name': 'P', 'boardId': str(self.board.id), 'graph': selection, 'scope': 'project', 'projectId': PROJECT})
        self.assertEqual((reply.status_code, reply.json()), (403, {'error': 'FORBIDDEN'}))
        ProjectMember.objects.create(project_id=PROJECT, user_id=self.mate.id, role='viewer', created_at=1, updated_at=1)
        reply = self.send('post', '/api/canvas-templates', {'name': 'P', 'boardId': str(self.board.id), 'graph': selection, 'scope': 'project', 'projectId': PROJECT})
        self.assertEqual(reply.status_code, 201, reply.content)
        self.assertEqual(reply.json()['template']['projectId'], PROJECT)

    def test_access_levels_personal_project_and_everyone(self):
        personal = self.make('personal')['id']
        project = self.make('project')['id']
        everyone = self.make('everyone')['id']
        self.assertEqual({personal, project, everyone} - set(self.listed(self.owner)), set())
        mate = self.listed(self.mate)
        self.assertNotIn(personal, mate)
        self.assertIn(project, mate)
        self.assertIn(everyone, mate)
        # The project scope only shows while that project is the one being viewed.
        elsewhere = self.listed(self.mate, project=str(uuid4()))
        self.assertNotIn(project, elsewhere)
        self.assertIn(everyone, elsewhere)
        self.as_user(self.mate)
        self.assertEqual(self.send('get', f'/api/canvas-templates/{personal}').status_code, 404)
        self.assertEqual(self.send('get', f'/api/canvas-templates/{everyone}').status_code, 200)

    def test_only_the_owner_or_an_admin_edits_and_deletes(self):
        entry = self.make('everyone')
        path = f'/api/canvas-templates/{entry["id"]}'
        self.as_user(self.mate)
        self.assertEqual(self.send('patch', path, {'name': 'Stolen'}).status_code, 403)
        self.assertEqual(self.send('delete', path).status_code, 403)
        self.as_user(self.owner)
        self.assertEqual(self.send('patch', path, {'name': 'Renamed', 'category': 'agile', 'tags': ['A', 'a', 'b']}).json()['template']['tags'], ['a', 'b'])
        self.as_user(self.admin)
        self.assertEqual(self.send('patch', path, {'description': 'By admin'}).status_code, 200)

    def test_delete_is_soft_and_can_be_undone(self):
        entry = self.make('everyone')
        path = f'/api/canvas-templates/{entry["id"]}'
        self.as_user(self.owner)
        self.assertEqual(self.send('delete', path).status_code, 200)
        self.assertNotIn(entry['id'], self.listed(self.owner))
        self.assertEqual(self.send('get', path).status_code, 404)
        self.assertEqual(self.send('patch', path, {'deleted': False}).status_code, 200)
        self.assertIn(entry['id'], self.listed(self.owner))

    def test_only_an_admin_features_and_featured_sorts_first(self):
        entry = self.make('everyone')
        path = f'/api/canvas-templates/{entry["id"]}'
        self.as_user(self.owner)
        self.assertEqual(self.send('patch', path, {'featured': True}).status_code, 403)
        self.as_user(self.admin)
        self.assertTrue(self.send('patch', path, {'featured': True}).json()['template']['featured'])
        self.as_user(self.mate)
        listing = self.send('get', '/api/canvas-templates').json()['templates']
        flags = [item['featured'] for item in listing]
        self.assertEqual(flags, sorted(flags, reverse=True))

    def test_likes_and_comments_work_for_shipped_and_custom_templates(self):
        entry = self.make('everyone')
        for ref in ('builtin:swot', entry['id']):
            self.as_user(self.mate)
            self.assertEqual(self.send('post', f'/api/canvas-templates/{ref}/like', {'liked': True}).json(), {'liked': True, 'likes': 1})
            self.assertEqual(self.send('post', f'/api/canvas-templates/{ref}/like', {'liked': True}).json()['likes'], 1)
            self.as_user(self.other)
            self.assertEqual(self.send('post', f'/api/canvas-templates/{ref}/like', {'liked': True}).json()['likes'], 2)
            self.assertEqual(self.send('post', f'/api/canvas-templates/{ref}/like', {'liked': False}).json()['likes'], 1)
            comment = self.send('post', f'/api/canvas-templates/{ref}/comments', {'body': ' Nice one '})
            self.assertEqual(comment.status_code, 201)
            self.assertEqual(comment.json()['comments'][-1]['body'], 'Nice one')
            self.assertEqual(self.send('post', f'/api/canvas-templates/{ref}/comments', {'body': ''}).status_code, 400)
        self.as_user(self.mate)
        listing = {item['id']: item for item in self.send('get', '/api/canvas-templates').json()['templates']}
        self.assertTrue(listing['builtin:swot']['liked'])
        self.assertEqual(listing['builtin:swot']['commentCount'], 1)

    def test_personal_templates_cannot_be_liked_by_others(self):
        entry = self.make('personal')
        self.as_user(self.mate)
        self.assertEqual(self.send('post', f'/api/canvas-templates/{entry["id"]}/like', {'liked': True}).status_code, 404)

    def test_usage_is_counted_and_only_admins_read_the_insights(self):
        entry = self.make('everyone')
        self.as_user(self.mate)
        for ref in ('builtin:swot', 'builtin:swot', entry['id']):
            self.assertEqual(self.send('post', f'/api/canvas-templates/{ref}/use', {'boardId': str(self.board.id)}).status_code, 200)
        self.assertEqual(self.send('post', '/api/canvas-templates/builtin:nope/use', {}).status_code, 404)
        self.assertEqual(self.send('get', '/api/admin/template-usage').status_code, 403)
        self.as_user(self.admin)
        usage = self.send('get', '/api/admin/template-usage').json()['usage']
        self.assertEqual({item['ref']: item['last30Days'] for item in usage}, {'builtin:swot': 2, entry['id']: 1})
        self.assertEqual(usage[0]['lastYear'], 2)

    def test_old_usage_counts_in_the_year_but_not_the_month(self):
        from .models import BoardTemplateUsage
        day = templates.DAY_MS
        BoardTemplateUsage.objects.create(id=uuid4(), template_ref='builtin:swot', kind='builtin', name='SWOT', created_at=1000 * day)
        usage = templates.usage_insights(now=1000 * day + 100 * day)
        self.assertEqual((usage[0]['last30Days'], usage[0]['lastYear']), (0, 1))

    def test_create_a_board_from_a_shipped_template(self):
        self.as_user(self.owner)
        reply = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': PROJECT, 'name': 'Retro', 'templateId': 'builtin:retro-start-stop-continue'})
        self.assertEqual(reply.status_code, 200)
        created = CanvasBoard.objects.get(pk=reply.json()['board']['id'])
        shipped = template_catalog.template('retro-start-stop-continue')['graph']
        self.assertEqual(len(created.data['nodes']), len(shipped['nodes']))
        self.assertFalse({n['id'] for n in created.data['nodes']} & {n['id'] for n in shipped['nodes']})
        self.assertEqual(created.version, 1)

    def test_create_a_blank_board_from_a_template_clears_stickies(self):
        self.as_user(self.owner)
        reply = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': PROJECT, 'name': 'Blank', 'templateId': 'builtin:swot', 'blank': True})
        data = CanvasBoard.objects.get(pk=reply.json()['board']['id']).data
        self.assertTrue(all(n['text'] == '' for n in data['nodes'] if n['type'] == 'sticky'))
        self.assertTrue(any(n['type'] == 'text' and n['text'] for n in data['nodes']))

    def test_boards_from_a_whole_board_template_or_blueprint_keep_its_layers(self):
        layered = {'version': 1, 'nodes': [sticky('s1', 'Hello', layerId='base'), sticky('s2', 'Top', layerId='notes')],
                   'connectors': [], 'settings': LAYERED_SETTINGS}
        CanvasBoard.objects.filter(pk=self.board.id).update(data=layered)
        entry = self.make()
        self.as_user(self.owner)
        blueprint = self.send('post', '/api/canvas-blueprints', {'name': 'Layered', 'sourceProjectId': PROJECT}).json()['blueprint']
        from_template = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': PROJECT, 'name': 'T', 'templateId': entry['id']})
        from_blueprint = self.send('post', f'/api/canvas-blueprints/{blueprint["id"]}/use', {'name': 'B'})
        for board_id in (from_template.json()['board']['id'], from_blueprint.json()['boards'][0]['id']):
            data = CanvasBoard.objects.get(pk=board_id).data
            self.assertEqual(data['settings'], {'background': '#112233', 'layers': LAYERED_SETTINGS['layers']})
            self.assertEqual({item['text']: item['layerId'] for item in data['nodes']}, {'Hello': 'base', 'Top': 'notes'})

    def test_template_and_blueprint_media_is_copied_outside_any_transaction(self):
        storage = StorageService(MemoryAdapter())
        image = b'\x89PNG\r\n\x1a\nfixture'
        source = f'canvas/{self.board.id}/{uuid4()}.png'
        storage.primary.put(source, image, 'image/png', 'private')
        CanvasBoard.objects.filter(pk=self.board.id).update(data={'version': 1, 'connectors': [], 'nodes': [
            {'id': 'i1', 'type': 'image', 'x': 0, 'y': 0, 'w': 100, 'h': 80, 'parentId': None, 'groupId': None, 'src': '/api/media/' + source}]})
        uploads = []
        upload = storage.upload_stream

        def recording(stream, key, *args):
            uploads.append((key, connection.in_atomic_block))
            return upload(stream, key, *args)

        with patch('apps.media.storage.get_storage', return_value=storage), patch.object(storage, 'upload_stream', recording):
            entry = self.make()
            self.as_user(self.owner)
            blueprint = self.send('post', '/api/canvas-blueprints', {'name': 'Media', 'sourceProjectId': PROJECT}).json()['blueprint']
            scratch = self.send('post', '/api/canvas-templates', {'name': 'Scratch', 'fromScratch': True, 'projectId': PROJECT}).json()['template']
            CanvasBoard.objects.filter(pk=scratch['boardId']).update(data=CanvasBoard.objects.get(pk=self.board.id).data)
            self.assertEqual(self.send('patch', f'/api/canvas-templates/{scratch["id"]}', {'syncBoard': True}).status_code, 200)
        template_src = BoardTemplate.objects.get(pk=entry['id']).graph['nodes'][0]['src']
        synced_src = BoardTemplate.objects.get(pk=scratch['id']).graph['nodes'][0]['src']
        blueprint_src = Blueprint.objects.get(pk=blueprint['id'].removeprefix('blueprint:')).boards[0]['graph']['nodes'][0]['src']
        self.assertTrue(template_src.startswith(f'/api/media/canvas/templates/{entry["id"]}/'))
        self.assertTrue(synced_src.startswith(f'/api/media/canvas/templates/{scratch["id"]}/'))
        self.assertTrue(blueprint_src.startswith(f'/api/media/canvas/blueprints/{blueprint["id"].removeprefix("blueprint:")}/'))
        for src in (template_src, synced_src, blueprint_src):
            self.assertEqual(storage.read(src.removeprefix('/api/media/')), image)
        self.assertEqual(len(uploads), 3)
        self.assertFalse(any(in_atomic for _, in_atomic in uploads))

    def test_creating_from_an_unknown_or_hidden_template_fails_without_a_board(self):
        hidden = self.make('personal')
        before = CanvasBoard.objects.count()
        self.as_user(self.mate)
        for ref in ('builtin:nope', hidden['id']):
            reply = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': PROJECT, 'name': 'X', 'templateId': ref})
            self.assertEqual(reply.status_code, 404)
        self.assertEqual(CanvasBoard.objects.count(), before)

    def test_template_from_scratch_edits_in_an_ordinary_board_and_syncs_back(self):
        self.as_user(self.owner)
        reply = self.send('post', '/api/canvas-templates', {'name': 'Scratch', 'fromScratch': True, 'projectId': PROJECT})
        self.assertEqual(reply.status_code, 201)
        entry = reply.json()['template']
        self.publish(entry['id'])
        self.as_user(self.owner)
        self.assertEqual(entry['nodeCount'], 0)
        board = CanvasBoard.objects.get(pk=entry['boardId'])
        self.assertEqual(board.name, 'Template: Scratch')
        path = f'/api/canvas-templates/{entry["id"]}'
        self.assertEqual(self.send('patch', path, {'syncBoard': True}).status_code, 400)
        CanvasBoard.objects.filter(pk=board.id).update(data={'version': 1, 'nodes': [sticky('n1', 'Drawn')], 'connectors': []})
        synced = self.send('patch', path, {'syncBoard': True}).json()['template']
        self.assertEqual(synced['nodeCount'], 1)
        self.assertEqual(self.send('get', f'/api/canvas-templates/by-board/{board.id}').json()['template']['id'], entry['id'])
        # Another person finds the board's template only when they may see it.
        self.as_user(self.mate)
        self.assertEqual(self.send('get', f'/api/canvas-templates/by-board/{board.id}').json()['template']['id'], entry['id'])
        self.assertEqual(self.send('patch', path, {'syncBoard': True}).status_code, 403)

    def test_edit_board_opens_once_per_template(self):
        entry = self.make('personal')
        self.as_user(self.owner)
        first = self.send('post', f'/api/canvas-templates/{entry["id"]}/edit-board', {'projectId': PROJECT}).json()
        # Opened later from another project, the editing board still reports the project it lives in.
        second = self.send('post', f'/api/canvas-templates/{entry["id"]}/edit-board', {'projectId': str(uuid4())}).json()
        self.assertEqual(first, second)
        self.assertEqual(first['projectId'], PROJECT)
        self.assertEqual(len(CanvasBoard.objects.get(pk=first['boardId']).data['nodes']), 1)

    def test_blueprint_starts_a_project_with_boards_from_templates(self):
        self.as_user(self.owner)
        listing = self.send('get', '/api/canvas-blueprints').json()['blueprints']
        self.assertIn('blueprint:builtin:product-launch', {item['id'] for item in listing})
        projects_before = Project.objects.count()
        reply = self.send('post', '/api/canvas-blueprints/blueprint:builtin:product-launch/use', {'name': 'Launch Q4'})
        self.assertEqual(reply.status_code, 201, reply.content)
        made = reply.json()
        self.assertEqual(Project.objects.count(), projects_before + 1)
        self.assertEqual([b['name'] for b in made['boards']], ['Brainstorm', 'Roadmap', 'Retrospective'])
        self.assertEqual(CanvasBoard.objects.filter(project_id=made['project']['id']).count(), 3)
        self.assertTrue(ProjectMember.objects.filter(project_id=made['project']['id'], user_id=self.owner.id, role='owner').exists())

    def test_blueprint_use_without_a_name_creates_nothing(self):
        self.as_user(self.owner)
        projects, boards = Project.objects.count(), CanvasBoard.objects.count()
        self.assertEqual(self.send('post', '/api/canvas-blueprints/blueprint:builtin:product-launch/use', {}).status_code, 400)
        self.assertEqual((Project.objects.count(), CanvasBoard.objects.count()), (projects, boards))

    def test_object_locks_never_travel_with_a_template_or_blueprint_but_layer_locks_do(self):
        lock = {'locked': True, 'lockedBy': str(self.owner.id), 'lockProtected': True}
        CanvasBoard.objects.filter(pk=self.board.id).update(data={
            'version': 1, 'connectors': [], 'settings': LAYERED_SETTINGS,
            'nodes': [sticky('s1', 'Guarded', **lock), sticky('s2', 'Plain', locked=True, layerId='base')]})
        entry = self.make()
        self.as_user(self.owner)
        blueprint = self.send('post', '/api/canvas-blueprints', {'name': 'Locked', 'sourceProjectId': PROJECT}).json()['blueprint']
        inserted = self.send('get', f'/api/canvas-templates/{entry["id"]}').json()['template']['graph']
        from_template = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': PROJECT, 'name': 'T', 'templateId': entry['id']})
        from_blueprint = self.send('post', f'/api/canvas-blueprints/{blueprint["id"]}/use', {'name': 'B'})
        boards = [CanvasBoard.objects.get(pk=board_id).data for board_id in
                  (from_template.json()['board']['id'], from_blueprint.json()['boards'][0]['id'])]
        for graph in (inserted, *boards):
            self.assertEqual([sorted(lock.keys() & item.keys()) for item in graph['nodes']], [[], []])
            self.assertEqual(graph['settings']['layers'], LAYERED_SETTINGS['layers'])

    def test_only_an_admin_features_a_template_or_blueprint_as_it_is_saved(self):
        self.as_user(self.owner)
        for path, body in (('/api/canvas-templates', {'name': 'T', 'boardId': str(self.board.id)}),
                           ('/api/canvas-blueprints', {'name': 'B', 'sourceProjectId': PROJECT})):
            self.assertEqual(self.send('post', path, {**body, 'featured': True}).status_code, 403)
        self.assertFalse(BoardTemplate.objects.exists() or Blueprint.objects.exists())
        self.as_user(self.admin)
        template = self.send('post', '/api/canvas-templates', {'name': 'T', 'boardId': str(self.board.id), 'featured': True})
        blueprint = self.send('post', '/api/canvas-blueprints', {'name': 'B', 'sourceProjectId': PROJECT, 'featured': True})
        self.assertTrue(template.json()['template']['featured'])
        self.assertTrue(blueprint.json()['blueprint']['featured'])
        self.assertTrue(BoardTemplate.objects.get().featured and Blueprint.objects.get().featured)

    def test_custom_blueprint_snapshots_a_project_and_later_edits_do_not_change_made_projects(self):
        self.as_user(self.owner)
        reply = self.send('post', '/api/canvas-blueprints', {'name': 'Mine', 'sourceProjectId': PROJECT, 'scope': 'project', 'projectId': PROJECT})
        self.assertEqual(reply.status_code, 201, reply.content)
        ref = reply.json()['blueprint']['id']
        self.assertEqual(reply.json()['blueprint']['boards'], [{'name': 'Board', 'nodeCount': 1}])
        listed = {b['id']: b for b in self.send('get', f'/api/canvas-blueprints?projectId={PROJECT}').json()['blueprints']}
        self.assertEqual(listed[ref]['boards'], [{'name': 'Board', 'nodeCount': 1}])
        made = self.send('post', f'/api/canvas-blueprints/{ref}/use', {'name': 'From mine'}).json()
        self.assertEqual(len(CanvasBoard.objects.get(pk=made['boards'][0]['id']).data['nodes']), 1)
        self.send('patch', f'/api/canvas-blueprints/{ref}', {'name': 'Renamed'})
        self.assertEqual(len(CanvasBoard.objects.get(pk=made['boards'][0]['id']).data['nodes']), 1)
        self.as_user(self.mate)
        self.assertEqual(self.send('patch', f'/api/canvas-blueprints/{ref}', {'name': 'x'}).status_code, 403)
        self.assertEqual(self.send('delete', f'/api/canvas-blueprints/{ref}').status_code, 403)
        self.as_user(self.owner)
        self.assertEqual(self.send('delete', f'/api/canvas-blueprints/{ref}').status_code, 200)
        self.assertNotIn(ref, {b['id'] for b in self.send('get', '/api/canvas-blueprints').json()['blueprints']})

    def test_a_blueprint_needs_edit_rights_on_every_board_it_includes(self):
        CanvasBoard.objects.create(id=uuid4(), project_id=PROJECT, name='Read only', created_by=self.owner.id, team_role='view',
                                   data={'version': 1, 'nodes': [sticky('r')], 'connectors': []}, created_at=2, updated_at=2)
        self.as_user(self.mate)
        reply = self.send('post', '/api/canvas-blueprints', {'name': 'Copy', 'sourceProjectId': PROJECT})
        self.assertEqual((reply.status_code, reply.json()), (403, {'error': 'FORBIDDEN'}))
        refused = self.send('post', '/api/canvas-blueprints', {'name': 'All', 'sourceProjectId': PROJECT, 'scope': 'everyone'})
        self.assertEqual(refused.status_code, 403)
        CanvasBoard.objects.filter(project_id=PROJECT).update(team_role='edit')
        reply = self.send('post', '/api/canvas-blueprints', {'name': 'Copy', 'sourceProjectId': PROJECT})
        self.assertEqual(reply.status_code, 201, reply.content)
        self.assertEqual([b['name'] for b in reply.json()['blueprint']['boards']], ['Board', 'Read only'])

    def test_a_blueprint_keeps_the_first_boards_and_reports_how_many_were_left_out(self):
        for index in range(3):
            CanvasBoard.objects.create(id=uuid4(), project_id=PROJECT, name=f'Extra {index}', created_by=self.owner.id,
                                       data={'version': 1, 'nodes': [sticky(f'e{index}')], 'connectors': []},
                                       created_at=10 + index, updated_at=10 + index)
        self.as_user(self.owner)
        with patch.object(templates, 'BLUEPRINT_MAX_BOARDS', 2):
            reply = self.send('post', '/api/canvas-blueprints', {'name': 'Capped', 'sourceProjectId': PROJECT})
        self.assertEqual(reply.status_code, 201, reply.content)
        self.assertEqual(reply.json()['leftOut'], 2)
        self.assertEqual([b['name'] for b in reply.json()['blueprint']['boards']], ['Board', 'Extra 0'])
        whole = self.send('post', '/api/canvas-blueprints', {'name': 'Whole', 'sourceProjectId': PROJECT}).json()
        self.assertEqual((whole['leftOut'], len(whole['blueprint']['boards'])), (0, 4))
