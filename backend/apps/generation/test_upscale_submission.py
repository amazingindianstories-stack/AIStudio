from types import SimpleNamespace
from unittest.mock import Mock
from django.test import SimpleTestCase
from .services.deadline import Cancellation
from .services.upscale_submission import submit_persisted_upscale
from .test_enqueue import data_url


class DurableUpscaleSubmissionTests(SimpleTestCase):
    def fixture(self):
        item=SimpleNamespace(model='Magnific Precision V2',submission_input={'version':1,
            'source':'/api/media/references/job-original.png','params':{'scaleFactor':'4x',
            'flavor':'photo','sharpen':7,'smartGrain':7,'ultraDetail':30}})
        storage=Mock();storage.read_as_base64.return_value={'mimeType':'image/png','data':data_url().split(',',1)[1]}
        return item,storage

    def test_marker_precedes_single_submit_and_receipt_survives_cancellation(self):
        item,storage=self.fixture();events=[];signal=Cancellation()
        def submit(payload,**kwargs):
            events.append('submit');signal.cancelled.set();return {'taskId':'accepted'}
        task=submit_persisted_upscale(item,signal=signal,storage=storage,submit=submit,
            mark_pending=lambda:events.append('pending'),save_receipt=lambda task:events.append(task),
            mark_uncertain=lambda:events.append('uncertain'))
        self.assertEqual(task,'accepted');self.assertEqual(events,['pending','submit','accepted'])

    def test_ambiguous_error_is_retained_and_never_retried(self):
        item,storage=self.fixture();submit=Mock(side_effect=TimeoutError());uncertain=Mock()
        with self.assertRaises(TimeoutError):
            submit_persisted_upscale(item,signal=Cancellation(),storage=storage,submit=submit,
                mark_pending=Mock(),save_receipt=Mock(),mark_uncertain=uncertain)
        submit.assert_called_once();uncertain.assert_called_once()

    def test_failed_intent_fence_never_submits(self):
        item,storage=self.fixture();submit=Mock()
        with self.assertRaises(RuntimeError):
            submit_persisted_upscale(item,signal=Cancellation(),storage=storage,submit=submit,
                mark_pending=Mock(side_effect=RuntimeError('lost lease')),save_receipt=Mock(),mark_uncertain=Mock())
        submit.assert_not_called()

    def test_malformed_or_signed_persisted_inputs_never_read_or_submit(self):
        for extra in [{'version':True},{'version':2},{'source':'https://evil.invalid/api/media/references/a.png'},
                      {'source':'/api/media/references/a.png?token=secret'},
                      {'source':'/api/media/references/%2e%2e/settings/key'}]:
            item,storage=self.fixture();item.submission_input.update(extra)
            submit=Mock();pending=Mock()
            with self.assertRaises(ValueError):
                submit_persisted_upscale(item,signal=Cancellation(),storage=storage,submit=submit,
                    mark_pending=pending,save_receipt=Mock(),mark_uncertain=Mock())
            storage.read_as_base64.assert_not_called();submit.assert_not_called();pending.assert_not_called()

    def test_accepted_receipt_write_failure_marks_uncertain_without_resubmit(self):
        item,storage=self.fixture();submit=Mock(return_value={'taskId':'accepted'});uncertain=Mock()
        with self.assertRaisesRegex(RuntimeError,'receipt write failed'):
            submit_persisted_upscale(item,signal=Cancellation(),storage=storage,submit=submit,
                mark_pending=Mock(),save_receipt=Mock(side_effect=RuntimeError('receipt write failed')),
                mark_uncertain=uncertain)
        submit.assert_called_once();uncertain.assert_called_once()
