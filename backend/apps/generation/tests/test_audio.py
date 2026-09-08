import base64
from unittest.mock import Mock, patch
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from apps.common.test_utils import SECRET, _cookie_for, _make_user
from apps.projects.models import Project
from apps.generation.models import Generation
from apps.generation.mentions import resolve_audio_references, parse_asset_slugs

@override_settings(AUTH_SECRET=SECRET)
class AudioTests(TestCase):
    def setUp(self):
        self.user = _make_user()
        self.client = APIClient()
        self.client.cookies['veevee_session'] = _cookie_for(str(self.user.id))
        self.project = Project.objects.create(name='Audio fixture', created_at=1, updated_at=1)
        self.ref = f'/api/media/uploads/audio-reference/{self.user.id}-fixture'

    @patch.dict('os.environ', {'GOOGLE_API_KEY': 'test-only'})
    @patch('apps.generation.audio_views.requests.post')
    @patch('apps.generation.audio_views.read_as_base64', return_value=('audio/mpeg', base64.b64encode(b'audio').decode()))
    def test_transcription_roundtrip_and_project_history(self, read, post):
        post.return_value = Mock(ok=True, json=lambda: {'candidates': [{'content': {'parts': [{'text': '[00:00.000 - 00:01.000] Speaker: hello'}]}}]})
        response = self.client.post('/api/audio/transcribe', {'audioRef': self.ref, 'projectId': str(self.project.id), 'name': 'test.mp3'}, format='json')
        self.assertEqual(response.status_code, 200, response.json())
        item = response.json()
        self.assertIn('gemini-2.5-flash:generateContent', post.call_args.args[0])
        saved = Generation.objects.get(id=item['id'])
        self.assertEqual(saved.reference_audios, [self.ref])
        self.assertEqual(saved.production_metadata['transcript'], item['transcript'])
        history = self.client.get('/api/history', {'kind': 'audio', 'projectId': str(self.project.id)}).json()['items']
        self.assertEqual([row['id'] for row in history], [item['id']])
        other = Project.objects.create(name='Other', created_at=1, updated_at=1)
        self.assertEqual(self.client.get('/api/history', {'kind': 'audio', 'projectId': str(other.id)}).json()['items'], [])

    @patch('apps.generation.audio_views.read_as_base64')
    def test_auth_and_untrusted_reference_never_read(self, read):
        self.assertEqual(APIClient().post('/api/audio/transcribe', {}, format='json').status_code, 401)
        for ref in ['http://127.0.0.1/secret', '/api/media/private/key', self.ref + '/../secret']:
            self.assertEqual(self.client.post('/api/audio/transcribe', {'audioRef': ref}, format='json').status_code, 400)
        read.assert_not_called()

    @patch('apps.media.upload_views.get_signed_upload_url', return_value='https://upload.invalid/signed')
    def test_common_audio_uploads(self, signer):
        for mime in ['audio/mpeg','audio/wav','audio/mp4','audio/ogg','audio/aac','audio/flac','audio/webm']:
            response = self.client.post('/api/uploads/presign', {'purpose':'audio-reference','contentType':mime}, format='json')
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.post('/api/uploads/presign', {'purpose':'audio-reference','contentType':'image/png'}, format='json').status_code, 400)

    def test_tagged_audio_selection(self):
        self.assertEqual(resolve_audio_references('use @audio2', ['a','b']), ['b'])
        self.assertEqual(resolve_audio_references('music', ['a','b']), ['a','b'])
        self.assertEqual(parse_asset_slugs('@audio1 @hero'), ['hero'])

    @patch.dict('os.environ', {'ARK_API_KEY': 'test-only'})
    @patch('apps.generation.providers.seedance.requests.post')
    def test_seedance_audio_payload(self, post):
        from apps.generation.providers.seedance import create_video_task
        post.return_value = Mock(ok=True, json=lambda: {'id': 'fixture-task'})
        self.assertEqual(create_video_task('use @audio1', model_display='Seedance 2.5', reference_audio_urls=['https://media.invalid/audio']), 'fixture-task')
        content = post.call_args.kwargs['json']['content']
        self.assertIn('[audio 1]', content[0]['text'])
        self.assertIn({'type': 'audio_url', 'audio_url': {'url': 'https://media.invalid/audio'}, 'role': 'reference_audio'}, content)
