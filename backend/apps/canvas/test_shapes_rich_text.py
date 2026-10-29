"""Format v1 path shapes and rich-text marks, held to the cases the frontend serializer also runs."""
import copy
import json
from uuid import uuid4
from pathlib import Path

from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.admin_dashboard import tests as session_fixtures
from .activity import STAMP_KEYS
from .models import CanvasBoard
from .serialization import MAX_MARKS, marks, validate_state

FIXTURE = json.loads((Path(__file__).with_name('fixtures') / 'format_v1_shapes_rich_text.json').read_text())


class ShapesRichTextSerializationTests(SimpleTestCase):
    def test_shared_cases_match_the_frontend_serializer(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                self.assertEqual(validate_state(copy.deepcopy(case['input'])), case['expected'])

    def test_validated_boards_round_trip_unchanged(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                once = validate_state(copy.deepcopy(case['expected']))
                self.assertEqual(validate_state(json.loads(json.dumps(once))), once)

    def test_plain_text_boards_gain_no_marks(self):
        output = validate_state(copy.deepcopy(FIXTURE['cases']['legacy']['input']))
        self.assertTrue(all('marks' not in node for node in output['nodes']))
        self.assertEqual(output, FIXTURE['cases']['legacy']['expected'])

    def test_marks_use_utf16_offsets_and_the_per_node_cap(self):
        # '😀' is two UTF-16 code units, as in JavaScript string indices.
        self.assertEqual(marks([[0, 9, 'b'], [2, 3, 'i'], [3, 4, 'u']], '😀a'), [[0, 3, 'b'], [2, 3, 'i']])
        self.assertEqual(marks([[0, 1, 'b']], 'a\ud800'), [[0, 1, 'b']])
        many = [[index % 10, index % 10 + 1, 'b'] for index in range(MAX_MARKS + 5)]
        kept = marks(many, 'x' * 10)
        self.assertEqual(len(kept), MAX_MARKS)
        self.assertEqual(kept[-1], many[MAX_MARKS - 1])

    def test_links_must_be_http_https_or_mailto_without_trailing_newline(self):
        def link(href):
            return marks([[0, 1, 'a', href]], 'x')
        self.assertEqual(link('https://example.com'), [[0, 1, 'a', 'https://example.com']])
        for href in ['javascript:alert(1)', 'https://x\n', 'https://x\r', 'mailto:a\n', 'httpſ://x', 'ftp://x', 'https://', 7]:
            with self.subTest(href=href):
                self.assertIsNone(link(href))


def unstamped(graph):
    """The graph without the server's author and time stamps, which the shared fixture leaves out."""
    return {**graph, **{key: [{k: v for k, v in item.items() if k not in STAMP_KEYS} for item in graph[key]]
                        for key in ('nodes', 'connectors')}}


@override_settings(ROOT_URLCONF='apps.canvas.urls')
class ShapesRichTextSaveTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    board = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        CanvasBoard.objects.create(id=self.board, project_id=self.project, name='Shapes',
                                   created_by=session_fixtures.UID, data={}, created_at=1, updated_at=2)

    def save(self, data):
        """A save over the board's current version, as the editor sends it."""
        return {'data': data, 'baseVersion': CanvasBoard.objects.get(pk=self.board).version, 'saveId': str(uuid4())}

    def test_a_saved_board_keeps_shapes_and_sanitized_marks(self):
        self.cookie()
        case = FIXTURE['cases']['shapes']
        response = self.client.put('/api/canvas-boards/' + self.board, data=json.dumps(self.save(case['input'])),
                                   content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(unstamped(CanvasBoard.objects.get(pk=self.board).data), case['expected'])
        self.assertEqual(unstamped(self.client.get('/api/canvas-boards/' + self.board).json()['data']), case['expected'])
        unsafe = FIXTURE['cases']['marks']
        self.client.put('/api/canvas-boards/' + self.board, data=json.dumps(self.save(unsafe['input'])), content_type='application/json')
        stored = json.dumps(CanvasBoard.objects.get(pk=self.board).data)
        self.assertNotIn('javascript:', stored.lower())
        self.assertNotIn('data:text', stored)
        self.assertEqual(unstamped(CanvasBoard.objects.get(pk=self.board).data), unsafe['expected'])
