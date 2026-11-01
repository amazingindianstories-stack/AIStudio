"""The same saved media protocol cases execute in Django and the browser."""
import json
from pathlib import Path
from django.test import SimpleTestCase
from .serialization import validate_state
from .embeds import classify
from .activity import snippet


class MediaSerializationTests(SimpleTestCase):
    def test_shared_media_graphs(self):
        source = (Path(__file__).parent / 'fixtures/format_v1_media.json').read_text()
        # Board saves parse every JSON number as a float, as JavaScript does.
        for parse_int in (int, float):
            for name, case in json.loads(source, parse_int=parse_int)['cases'].items():
                with self.subTest(name=name, parse_int=parse_int.__name__):
                    self.assertEqual(validate_state(case['input']), case['expected'])

    def test_history_labels_media_by_title(self):
        for kind in ('audio', 'video', 'embed', 'linkcard'):
            self.assertEqual(snippet({'type': kind, 'title': 'Theme  song'}), 'Theme song')

    def test_provider_addresses_only(self):
        self.assertEqual(classify('https://www.youtube.com/embed/dQw4w9WgXcQ'), {'provider': 'youtube', 'kind': 'video'})
        self.assertIsNone(classify('https://youtube.com.evil.test/embed/dQw4w9WgXcQ'))
        self.assertIsNone(classify('https://youtu.be/dQw4w9WgXcQ'))
        self.assertIsNone(classify('http://player.vimeo.com/video/1234'))
        self.assertIsNone(classify('https://w.soundcloud.com/player/'))
