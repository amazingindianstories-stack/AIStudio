from uuid import uuid4

from django.test import SimpleTestCase, TransactionTestCase

from apps.admin_dashboard import tests as fixtures
from .models import Generation
from .serialization import generation_item
from .providers.seedance import MODERATION_MESSAGE
from . import failure_copy


class PublicErrorTests(SimpleTestCase):
    def row(self, **values):
        defaults = dict(id=uuid4(),kind='video',status='failed',model='Seedance 2.5',
            prompt='fixture',aspect_ratio='16:9',created_at=1,updated_at=2)
        return Generation(**{**defaults,**values})

    def test_untrusted_diagnostics_never_become_public_messages(self):
        for diagnostic in (
            'Authorization: Bearer private-fixture-token',
            'https://example.invalid/?key=private-fixture-token',
            'private-fixture-token',  # no recognizable credential syntax
        ):
            with self.subTest(diagnostic=diagnostic):
                row = self.row(error=diagnostic,provider_responses=[{'rawBody':diagnostic}])
                item = generation_item(row)
                self.assertEqual(item['error'],failure_copy.GENERIC['video'])
                self.assertNotIn('providerResponses',item)
                self.assertEqual(row.error,diagnostic)

    def test_controlled_moderation_deadline_and_missing_output_remain_actionable(self):
        self.assertEqual(generation_item(self.row(error=MODERATION_MESSAGE))['error'],failure_copy.FACE_GALLERY)
        self.assertEqual(generation_item(self.row(error='Generation exceeded the private-fixture-token-second internal deadline.'))['error'],failure_copy.DROPPED)
        for diagnostic in ('Generation exceeded the 270-second internal deadline.',
                'Provider reported success but returned no video.'):
            self.assertEqual(generation_item(self.row(error=diagnostic))['error'],diagnostic)
        item = generation_item(self.row(error='private-fixture-token',moderation_blocked=True))
        self.assertIn('provider moderation',item['error'])
        self.assertNotIn('private-fixture-token',item['error'])

    def test_failure_messages_identify_the_operation_without_provider_diagnostics(self):
        for kind,model,message in (
            ('image','Nano Banana Pro',failure_copy.GENERIC['image']),
            ('image','Magnific Precision V2',failure_copy.UPSCALE_FAILED),
            ('audio','Gemini (gemini-2.5-flash)',failure_copy.GENERIC['audio']),
            ('depth','Depth Anything (Local)',failure_copy.GENERIC['depth']),
        ):
            with self.subTest(kind=kind,model=model):
                self.assertEqual(generation_item(self.row(kind=kind,model=model,
                    error='private-fixture-token'))['error'],message)


class PublicErrorHttpTests(TransactionTestCase):
    setUp = fixtures.SettingsTests.setUp
    cookie = fixtures.SettingsTests.cookie

    def test_historical_failed_row_is_private_across_history_updates_and_status(self):
        self.cookie()
        diagnostic = 'private-fixture-token'
        row = Generation.objects.create(id=uuid4(),kind='video',status='failed',model='Seedance 2.5',
            prompt='fixture',aspect_ratio='16:9',created_at=1,updated_at=2,user_id=fixtures.UID,
            error=diagnostic,provider_responses=[{'rawBody':diagnostic}])
        for path,query in (
            ('/api/history',{}),
            ('/api/history/updates',{'since':'1'}),
            ('/api/generate/video/status',{'id':str(row.id)}),
        ):
            with self.subTest(path=path):
                response = self.client.get(path,query)
                self.assertEqual(response.status_code,200,response.content)
                self.assertNotIn(diagnostic,response.content.decode())
                self.assertIn(failure_copy.GENERIC['video'],response.content.decode())
                self.assertNotIn('providerResponses',response.content.decode())
        row.refresh_from_db()
        self.assertEqual(row.error,diagnostic)
        self.assertEqual(row.provider_responses,[{'rawBody':diagnostic}])
