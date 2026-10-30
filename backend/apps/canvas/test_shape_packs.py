"""Custom SVG shape packs: sanitized on upload, owned by their creator, optionally shared with the team."""
import json
from uuid import uuid4
from django.test import SimpleTestCase, TestCase, override_settings
from apps.authentication.models import User
from apps.authentication.session import sign_session
from .models import CustomShapePack
from .serialization import validate_state
from .svg_sanitize import MAX_SHAPES_PER_PACK, sanitize_svg

VALVE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0 L24 24" fill="none" stroke="#000"/></svg>'


def make_user(name, role='user'):
    return User.objects.create(id=uuid4(), email=f'{name}@example.invalid', name=name, role=role,
                               password_hash='x', password_salt='', created_at=1, is_active=True)


class SanitizeSvgTests(TestCase):
    def test_keeps_vector_markup_and_view_box(self):
        inner, view_box = sanitize_svg(VALVE)
        self.assertEqual(view_box, '0 0 24 24')
        self.assertIn('<path', inner)
        self.assertNotIn('<svg', inner)

    def test_bare_markup_gets_a_default_view_box(self):
        inner, view_box = sanitize_svg('<circle cx="5" cy="5" r="4"/>')
        self.assertEqual(view_box, '0 0 100 100')
        self.assertIn('<circle', inner)

    def test_strips_scripts_handlers_and_external_references(self):
        dirty = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script>'
                 '<foreignObject><div/></foreignObject><image href="https://x.invalid/a.png"/>'
                 '<rect width="5" height="5" onclick="alert(1)" fill="url(https://x.invalid/p)" stroke="red"/>'
                 '<use href="https://x.invalid/s.svg#a"/></svg>')
        inner, _ = sanitize_svg(dirty)
        for bad in ('script', 'foreignObject', 'image', 'onclick', 'x.invalid', 'alert'):
            self.assertNotIn(bad, inner)
        self.assertIn('stroke="red"', inner)

    def test_rejects_entities_empty_oversized_and_unsupported_content(self):
        for raw in ('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', '', '   ',
                    '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', '<svg', None, 5,
                    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/>' + ' ' * (50 * 1024) + '</svg>'):
            with self.assertRaises(ValueError, msg=repr(raw)[:40]):
                sanitize_svg(raw)


class BoardCustomShapeTests(SimpleTestCase):
    def saved_svg(self, svg):
        node = {'id': 'c-1', 'type': 'shape', 'shape': 'custom', 'x': 0, 'y': 0, 'w': 100, 'h': 100, 'parentId': None,
                'groupId': None, 'fill': '#fff', 'stroke': '#000', 'strokeWidth': 2, 'svg': svg, 'svgViewBox': '0 0 24 24'}
        return validate_state({'nodes': [node], 'connectors': [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})['nodes'][0].get('svg')

    def test_a_saved_board_stores_the_sanitized_markup(self):
        self.assertEqual(self.saved_svg(VALVE), sanitize_svg(VALVE)[0])
        dirty = ('<p><base href="https://x.invalid/"/></p><rect width="5" height="5" onload="alert(1)"/>'
                 '<use href="#a"/><SCRIPT>alert(1)</SCRIPT>')
        clean = self.saved_svg(dirty)
        self.assertIn('<rect', clean)
        for bad in ('base', 'x.invalid', 'onload', 'alert', 'use', 'SCRIPT', '<p'):
            self.assertNotIn(bad, clean)
        self.assertEqual(self.saved_svg(clean), clean)

    def test_markup_with_nothing_drawable_is_dropped(self):
        for raw in ('<script>alert(1)</script>', '<!DOCTYPE x [<!ENTITY a "b">]><rect/>', ''):
            self.assertIsNone(self.saved_svg(raw), raw)


@override_settings(ROOT_URLCONF='config.urls')
class ShapePackRouteTests(TestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.owner = make_user('owner')
        self.mate = make_user('mate')
        self.admin = make_user('admin', role='admin')

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def send(self, method, path, data=None):
        return getattr(self.client, method)(path, data=json.dumps(data if data is not None else {}), content_type='application/json')

    def create(self, **extra):
        self.as_user(self.owner)
        body = {'name': 'Plant', 'shapes': [{'name': 'Valve', 'svg': VALVE}], **extra}
        return self.send('post', '/api/canvas-shape-packs', body)

    def test_create_sanitizes_and_lists_for_the_owner_only_until_shared(self):
        created = self.create()
        self.assertEqual(created.status_code, 201)
        pack = created.json()['pack']
        self.assertEqual((pack['name'], pack['isOwner'], pack['shared'], pack['showNames']), ('Plant', True, False, True))
        self.assertEqual(pack['shapes'][0]['viewBox'], '0 0 24 24')
        self.assertNotIn('<svg', pack['shapes'][0]['svg'])
        self.as_user(self.mate)
        self.assertEqual(self.client.get('/api/canvas-shape-packs').json()['packs'], [])
        self.as_user(self.owner)
        self.send('patch', f"/api/canvas-shape-packs/{pack['id']}", {'shared': True})
        self.as_user(self.mate)
        listed = self.client.get('/api/canvas-shape-packs').json()['packs']
        self.assertEqual([(p['id'], p['isOwner']) for p in listed], [(pack['id'], False)])

    def test_rejects_bad_input_with_400(self):
        self.as_user(self.owner)
        for body in ({'name': '', 'shapes': []}, {'name': 'x', 'shapes': 'no'},
                     {'name': 'x', 'shapes': [{'svg': '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'}]},
                     {'name': 'x', 'shapes': [{'svg': VALVE}] * (MAX_SHAPES_PER_PACK + 1)}):
            self.assertEqual(self.send('post', '/api/canvas-shape-packs', body).status_code, 400, body)
        self.assertEqual(CustomShapePack.objects.count(), 0)

    def test_only_the_owner_or_an_admin_can_change_or_delete(self):
        pack_id = self.create(shared=True).json()['pack']['id']
        path = f'/api/canvas-shape-packs/{pack_id}'
        self.as_user(self.mate)
        self.assertEqual(self.send('patch', path, {'name': 'Mine now'}).status_code, 403)
        self.assertEqual(self.send('delete', path).status_code, 403)
        self.as_user(self.owner)
        renamed = self.send('patch', path, {'name': 'Renamed', 'showNames': False, 'addShapes': [{'name': 'Pump', 'svg': VALVE}]}).json()['pack']
        self.assertEqual((renamed['name'], renamed['showNames'], [s['name'] for s in renamed['shapes']]), ('Renamed', False, ['Valve', 'Pump']))
        self.as_user(self.admin)
        self.assertEqual(self.send('delete', path).status_code, 200)
        self.assertEqual(self.send('delete', path).status_code, 404)

    def test_requires_a_session_and_a_valid_id(self):
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/canvas-shape-packs').status_code, 401)
        self.as_user(self.owner)
        self.assertEqual(self.send('patch', '/api/canvas-shape-packs/not-a-uuid', {'name': 'x'}).status_code, 404)
        self.assertEqual(self.send('patch', f'/api/canvas-shape-packs/{uuid4()}', {'name': 'x'}).status_code, 404)
