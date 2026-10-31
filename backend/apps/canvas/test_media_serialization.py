"""The same saved media protocol cases execute in Django and the browser."""
import json
from pathlib import Path
from django.test import SimpleTestCase
from .serialization import validate_state
from .embeds import embed_from_url, embed_from_iframe, classify


class MediaSerializationTests(SimpleTestCase):
    def test_shared_media_graphs(self):
        cases = json.loads((Path(__file__).parent / 'fixtures/format_v1_media.json').read_text())['cases']
        for name, case in cases.items():
            with self.subTest(name=name):
                self.assertEqual(validate_state(case['input']), case['expected'])

    def test_provider_addresses_only(self):
        self.assertEqual(embed_from_url('https://youtu.be/dQw4w9WgXcQ')['src'],
                         'https://www.youtube.com/embed/dQw4w9WgXcQ')
        self.assertIsNone(classify('https://youtube.com.evil.test/embed/dQw4w9WgXcQ'))
        self.assertIsNone(embed_from_iframe('<iframe src="javascript:alert(1)">'))
        self.assertIsNone(embed_from_url('http://vimeo.com/1234'))
