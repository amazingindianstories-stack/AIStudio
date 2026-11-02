"""Format objects (Docs, Slides, HTML embeds, draw.io), Mermaid diagram source and wireframe screen links,
held to the cases the frontend serializer also runs, and how saves treat them."""
import copy
import json
from pathlib import Path

from unittest.mock import patch as mock
from uuid import uuid4

from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.authentication.session import sign_session
from apps.projects.models import Project
from . import patch
from .models import CanvasBoard
from .serialization import empty_state, json_length, validate_state
from .test_activity import BOARD, PROJECT, T0, graph
from .test_roles import make_user

FIXTURE = json.loads((Path(__file__).with_name('fixtures') / 'format_v1_formats.json').read_text())


class FormatSerializationTests(SimpleTestCase):
    def test_shared_cases_match_the_frontend_serializer(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                self.assertEqual(validate_state(copy.deepcopy(case['input'])), case['expected'])

    def test_validated_boards_round_trip_unchanged(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                once = validate_state(copy.deepcopy(case['expected']))
                self.assertEqual(validate_state(json.loads(json.dumps(once))), once)

    def test_an_unknown_format_kind_drops_the_node(self):
        state = validate_state({'nodes': [{'id': 'a', 'type': 'format', 'format': 'video', 'x': 0, 'y': 0, 'w': 1, 'h': 1}]})
        self.assertEqual(state['nodes'], [])

    def test_an_oversized_html_embed_is_emptied(self):
        node = {'id': 'a', 'type': 'format', 'format': 'html', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'html': 'x' * 50001}
        self.assertEqual(validate_state({'nodes': [node]})['nodes'][0]['html'], '')

    def test_half_an_emoji_in_format_text_becomes_a_replacement_character(self):
        text = 'x\ud83d'
        node = {'id': 'a', 'type': 'format', 'format': 'html', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'html': text, 'name': text}
        saved = validate_state({'nodes': [node]})['nodes'][0]
        self.assertEqual((saved['html'], saved['name']), ('x\ufffd', 'x\ufffd'))


class FormatSaveTests(SimpleTestCase):
    def test_a_format_object_saves_through_a_per_node_patch(self):
        stored = validate_state({'nodes': [{'id': 'd', 'type': 'format', 'format': 'doc', 'x': 0, 'y': 0, 'w': 9, 'h': 9, 'blocks': [{'id': 'b', 'type': 'p', 'text': 'one'}]}]})
        edited = copy.deepcopy(stored['nodes'][0])
        edited['blocks'][0]['text'] = 'two'
        result = validate_state(patch.apply_patch(stored, {'nodes': {'upsert': [edited]}}))
        self.assertEqual(result['nodes'][0]['blocks'][0]['text'], 'two')
        self.assertLess(json_length(result), 2 * 1024 * 1024)


@override_settings(ROOT_URLCONF='config.urls')
class FormatBoardSaveTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.ana = make_user('ana')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.ana.id,
                                   data=empty_state(), created_at=1, updated_at=1)

    def send(self, method, payload):
        self.client.cookies['veevee_session'] = sign_session(self.ana)
        body = {**payload, 'baseVersion': CanvasBoard.objects.get(pk=BOARD).version, 'saveId': str(uuid4())}
        with mock('apps.canvas.services.now_ms', return_value=T0):
            response = getattr(self.client, method)('/api/canvas-boards/' + BOARD, content_type='application/json',
                                                    data=json.dumps(body))
        self.assertEqual(response.status_code, 200, response.content)

    def test_a_doc_ending_in_half_an_emoji_saves_and_keeps_saving(self):
        doc = {'id': 'd', 'type': 'format', 'format': 'doc', 'x': 0, 'y': 0, 'w': 9, 'h': 9,
               'blocks': [{'id': 'b', 'type': 'p', 'text': 'x' * 4998 + ' \ud83d'}]}
        self.send('put', {'data': graph(doc)})
        stored = CanvasBoard.objects.get(pk=BOARD).data['nodes'][0]
        self.assertEqual(stored['blocks'][0]['text'], 'x' * 4998 + ' \ufffd')
        edited = {**doc, 'blocks': [{'id': 'b', 'type': 'p', 'text': 'more \ud83d'}]}
        self.send('patch', {'patch': {'nodes': {'upsert': [edited]}}})
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).data['nodes'][0]['blocks'][0]['text'], 'more \ufffd')
