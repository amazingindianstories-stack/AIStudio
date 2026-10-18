"""Bounded database-only waiting; audio provider execution belongs to workers."""
import time
from apps.generation.models import Generation


class AudioResultPending(TimeoutError):
    def __init__(self, identifier):
        self.identifier=identifier
        super().__init__('Transcription is still pending. Check its saved history before retrying.')


class AudioFailed(RuntimeError):
    """The worker ended the transcription with a definite provider refusal (nothing pending to check)."""
    def __init__(self, row):
        from apps.generation.failure_copy import public_message
        self.identifier, self.busy = row.id, '429' in (row.error or '')
        super().__init__(public_message(row, row.error))


def wait_for_audio(expected, *, timeout=120, interval=.25, signal=None):
    deadline=time.monotonic()+timeout
    while True:
        if signal:
            signal.check()
        row=Generation.objects.filter(pk=expected.id).first()
        if (row is None or row.kind!='audio' or row.user_id!=expected.user_id
                or row.model!=expected.model or row.submission_input!=expected.submission_input):
            raise RuntimeError('Audio execution identity changed while waiting.')
        if row.status=='succeeded' and row.provider_status=='COMPLETED':
            if not isinstance(row.prompt,str) or not row.prompt.strip():
                raise RuntimeError('Audio completion is invalid.')
            return row
        if row.status=='failed' and row.provider_status!='SUBMISSION_UNCERTAIN':
            raise AudioFailed(row)
        if row.provider_status=='SUBMISSION_UNCERTAIN' or row.status in ('failed','cancelled'):
            raise AudioResultPending(row.id)
        remaining=deadline-time.monotonic()
        if remaining<=0:
            raise AudioResultPending(row.id)
        if signal:
            signal.wait(min(interval,remaining)*1000)
        else:
            time.sleep(min(interval,remaining))
