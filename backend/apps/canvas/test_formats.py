"""Format objects (Docs, Slides, HTML embeds, draw.io), Mermaid diagram source and wireframe screen links,
held to the cases the frontend serializer also runs, and how saves treat them."""
import copy
import json
from pathlib import Path

from django.test import SimpleTestCase

from . import patch
from .serialization import json_length, validate_state

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
        node = {'id': 'a', 'type': 'format', 'format': 'html', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'html': 'x' * 100001}
        self.assertEqual(validate_state({'nodes': [node]})['nodes'][0]['html'], '')


class FormatSaveTests(SimpleTestCase):
    def test_a_format_object_saves_through_a_per_node_patch(self):
        stored = validate_state({'nodes': [{'id': 'd', 'type': 'format', 'format': 'doc', 'x': 0, 'y': 0, 'w': 9, 'h': 9, 'blocks': [{'id': 'b', 'type': 'p', 'text': 'one'}]}]})
        edited = copy.deepcopy(stored['nodes'][0])
        edited['blocks'][0]['text'] = 'two'
        result = validate_state(patch.apply_patch(stored, {'nodes': {'upsert': [edited]}}))
        self.assertEqual(result['nodes'][0]['blocks'][0]['text'], 'two')
        self.assertLess(json_length(result), 2 * 1024 * 1024)
