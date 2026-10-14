"""One durable provider status state machine shared by workers and reconciliation.

Provider/transport errors stay retryable. Every terminal mutation compares the
observed task/status/version and, when supplied, worker ownership.
"""
import io
import os
import re
from urllib.parse import urlsplit
from uuid import uuid4

from django.db import transaction
from django.db.models import F
from PIL import Image

from apps.common.leases import now_ms
from apps.generation.model_registry import is_provider_model, model_definition
from apps.generation.models import Generation
from apps.generation.providers import magnific, omni
from apps.generation.realtime import publish_best_effort
from apps.media import persistence
from apps.media.errors import MediaTooLargeError
from apps.media.remote import get_media_fetcher
from apps.media.storage import get_storage
from . import coordinator
from .deadline import Cancellation
from .pricing import read_pricing, seedance_token_cost


MAGNIFIC_VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024
# Output links expire 30 minutes after generation (docs.magnific.com/quickstart);
# a few spaced attempts fit well inside that window.
MAGNIFIC_SAVE_ATTEMPTS = 3
MAGNIFIC_TOO_LARGE = 'The upscaled master is larger than 4 GB and could not be stored. Use H.264, a lower resolution or a shorter clip.'
MAGNIFIC_SAVE_FAILED = 'The upscaled master could not be downloaded and stored.'


def retry_after_ms(count):
    return min(60000, 30000 * 2 ** max(0, min(10, (count or 1) - 1)))


def video_extension(result):
    if result.get('outputFormat') in ('mov', 'mp4'):
        return result['outputFormat']
    path = urlsplit(result.get('url') or result.get('videoUrl') or '').path.lower()
    return 'mov' if path.endswith('.mov') else 'webm' if path.endswith('.webm') else 'mp4'


class Dependencies:
    def __init__(self, **overrides):
        self.__dict__.update(overrides)

    now = staticmethod(now_ms)
    save_url = staticmethod(persistence.save_from_url_with_metadata)
    save_base64 = staticmethod(persistence.save_base64_with_metadata)
    save_buffer = staticmethod(persistence.save_buffer_with_metadata)
    extract_frame = staticmethod(persistence.extract_last_frame_server)
    publish = staticmethod(publish_best_effort)
    pricing = staticmethod(read_pricing)
    mock = staticmethod(lambda: os.environ.get('MOCK_GENERATION') == '1')

    def read_reference(self, ref):
        return get_storage().read_as_base64(ref)

    def get_video(self, task_id, *, signal):
        from apps.generation.providers.seedance import get_video_task
        return get_video_task(task_id, signal=signal)

    def get_higgsfield(self, task_id, *, signal):
        from apps.generation.providers.higgsfield import job_status
        return job_status(task_id, signal=signal)

    get_omni = staticmethod(omni.get_video_status)
    get_magnific = staticmethod(magnific.get_upscale_status)
    get_magnific_video = staticmethod(magnific.get_video_upscale_status)

    def save_magnific_video(self, url, ext, identifier, metadata):
        # Same allowlisted fetcher, streamed to a spool file; ProRes masters
        # get a larger cap within the worker's per-job budget.
        import copy
        from apps.media.remote import SafeMediaFetcher
        fetcher = get_media_fetcher()
        if isinstance(fetcher, SafeMediaFetcher):
            # Same hosts, resolver and pinning; only the size cap and time budget differ.
            fetcher = copy.copy(fetcher)
            fetcher.max_bytes, fetcher.total_timeout = MAGNIFIC_VIDEO_MAX_BYTES, 240
        return persistence.save_from_url_with_metadata(url, ext, identifier, metadata, fetcher=fetcher)

    def fetch(self, url):
        return get_media_fetcher()(url)

    def judge_identity(self, reference, frame, signal):
        from apps.generation.prompting.face_judge import judge_identity
        return judge_identity(reference, frame, signal=signal)

    def judge_candidate(self, reference, frame, signal):
        from apps.generation.prompting.face_judge import judge_candidate
        return judge_candidate(reference, frame, signal=signal)


def _moderation(message):
    from apps.generation.providers.seedance import is_moderation_message, MODERATION_MESSAGE
    blocked = is_moderation_message(message or '')
    return blocked, MODERATION_MESSAGE if blocked else message or 'Generation failed.'


def _metadata(item):
    return {'kind': item.kind, 'model': item.model, 'requestedAspectRatio': item.aspect_ratio}


def _terminal(item, updates, deps, signal, owner, provider):
    signal.check()
    timestamp = deps.now()
    defaults = {'url': None, 'error': None, 'moderation_blocked': None,
                'completed_at': item.completed_at or timestamp, 'updated_at': timestamp}
    persisted = coordinator.compare_and_set_outcome(item, {**defaults, **provider, **updates}, owner=owner)
    if persisted is None:
        return {'kind': 'raced'}
    deps.publish(persisted)
    return {'kind': persisted.status, 'item': persisted}


def _pending(item, deps, signal, owner, provider, delay=5000):
    signal.check()
    with transaction.atomic():
        query = coordinator.expected_version(item, owner=owner).filter(task_id=item.task_id)
        if not query.update(poll_error_count=0, last_poll_error_at=None):
            return {'kind': 'raced'}
        persisted = coordinator.schedule_generation(item, now=deps.now(), delay_ms=delay, provider=provider, owner=owner)
    return {'kind': 'pending', 'item': persisted} if persisted else {'kind': 'raced'}


def _poll_error(item, deps, owner):
    with transaction.atomic():
        query = coordinator.expected_version(item, owner=owner).filter(task_id=item.task_id)
        if not query.update(poll_error_count=F('poll_error_count') + 1, last_poll_error_at=deps.now()):
            return {'kind': 'raced'}
        current = Generation.objects.get(pk=item.id)
        delay = retry_after_ms(current.poll_error_count)
        coordinator.schedule_generation(current, now=deps.now(), delay_ms=delay, owner=owner)
    return {'kind': 'poll_error', 'pollErrorCount': current.poll_error_count, 'retryAfterMs': delay}


def _best_of(item, deps, signal, owner, provider):
    results = []
    for task_id in [item.task_id, *(item.candidate_task_ids or [])]:
        signal.check()
        results.append({'taskId': task_id, **deps.get_video(task_id, signal=signal)})
    if any(result['status'] not in ('succeeded', 'failed') for result in results):
        return _pending(item, deps, signal, owner, provider)
    succeeded = [result for result in results if result['status'] == 'succeeded' and result.get('videoUrl')]
    if not succeeded:
        blocked = any(_moderation(result.get('error'))[0] for result in results)
        reason = next((result['error'] for result in results if result.get('error')), 'All candidates failed to generate.')
        if blocked:
            reason = _moderation('safety blocked')[1]
        return _terminal(item, {'status': 'failed', 'error': reason, 'moderation_blocked': blocked, 'candidate_task_ids': None}, deps, signal, owner, provider)
    winner, judge_score = succeeded[0], None
    reference = deps.read_reference(item.reference_images[0]) if item.reference_images else None
    if reference:
        judged = []
        for result in succeeded:
            signal.check()
            try:
                frame = deps.extract_frame(result['videoUrl'])
                judged.append((result, frame))
            except Exception:
                signal.check()
        if len(judged) > 1:
            if os.environ.get('JUDGE_COMPOSITE') == '1':
                from apps.generation.prompting.face_judge import select_best_candidate
                scores = [deps.judge_candidate(reference, frame, signal) for _, frame in judged]
                best = select_best_candidate(scores, 8)
                judge_score = scores[best]
            else:
                scores = [deps.judge_identity(reference, frame, signal) for _, frame in judged]
                best = max(range(len(scores)), key=lambda index: scores[index] if scores[index] is not None else -1)
                judge_score = {'identity': scores[best]} if scores[best] is not None else None
            winner = judged[best][0]
    signal.check()
    saved = deps.save_url(winner['videoUrl'], video_extension(winner), f'{item.id}/{uuid4().hex}', _metadata(item))
    return _terminal(item, {'status': 'succeeded', 'url': saved['url'], 'aspect_ratio': saved.get('aspectRatio') or item.aspect_ratio,
        'candidate_task_ids': None, 'judge_score': judge_score}, deps, signal, owner, provider)


def advance_magnific(item, *, signal=None, owner=None, dependencies=None):
    if item.model not in magnific.MODELS or item.kind != 'image' or not item.task_id:
        raise ValueError('Generation is not a Magnific job.')
    if item.status in ('succeeded', 'failed'):
        return {'kind': item.status, 'item': item}
    deps, signal = dependencies or Dependencies(), signal or Cancellation(60000)
    if deps.mock() and item.task_id == 'mock-magnific-'+str(item.id):
        source=(item.submission_input or {}).get('source')
        if not source:
            raise ValueError('Mock upscale requires its persisted reference.')
        return _terminal(item,{'status':'succeeded','url':source},deps,signal,owner,{'provider_status':'MOCK_COMPLETED'})
    outcome = deps.get_magnific(item.task_id, model=item.model, signal=signal)
    if outcome['status'] == 'running':
        return _pending(item, deps, signal, owner, {'provider_status': 'IN_PROGRESS'})
    if outcome['status'] == 'failed':
        return _terminal(item, {'status': 'failed', 'error': outcome.get('error') or 'Magnific upscale task failed.'}, deps, signal, owner, {'provider_status': 'FAILED'})
    data, _ = deps.fetch(outcome['generatedUrl'])
    if not data or len(data) > 80 * 1024 * 1024:
        raise ValueError('Magnific output is empty or too large.')
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 160000000:
            raise ValueError('Magnific output exceeds pixel limit.')
        extension = {'JPEG': 'jpg', 'PNG': 'png', 'WEBP': 'webp'}.get(image.format)
        if not extension:
            raise ValueError('Magnific output is not a supported image.')
        image.load()
    signal.check()
    saved = deps.save_buffer(data, extension, f'{item.id}/{uuid4().hex}', _metadata(item))
    updates = {'status': 'succeeded', 'url': saved['url'], 'aspect_ratio': saved.get('aspectRatio') or item.aspect_ratio}
    if type(outcome.get('costCents')) is int:
        updates.update(cost_cents=outcome['costCents'], cost_basis='reconciled')
    return _terminal(item, updates, deps, signal, owner, {'provider_status': 'COMPLETED'})


def advance_magnific_video(item, *, signal=None, owner=None, dependencies=None):
    if item.model not in magnific.VIDEO_MODELS or item.kind != 'video' or not item.task_id:
        raise ValueError('Generation is not a Magnific video job.')
    if item.status in ('succeeded', 'failed'):
        return {'kind': item.status, 'item': item}
    deps, signal = dependencies or Dependencies(), signal or Cancellation(60000)
    source = (item.submission_input or {}).get('source')
    if deps.mock() and item.task_id == 'mock-magnific-'+str(item.id):
        if not source:
            raise ValueError('Mock upscale requires its persisted reference.')
        return _terminal(item, {'status': 'succeeded', 'url': source}, deps, signal, owner, {'provider_status': 'MOCK_COMPLETED'})
    output_format = ((item.submission_input or {}).get('params') or {}).get('outputFormat') or 'h264'
    outcome = deps.get_magnific_video(item.task_id, model=item.model, output_format=output_format, signal=signal)
    if outcome['status'] == 'running':
        return _pending(item, deps, signal, owner, {'provider_status': 'IN_PROGRESS'}, 10000)
    if outcome['status'] == 'failed':
        return _terminal(item, {'status': 'failed', 'error': outcome.get('error') or 'Magnific upscale task failed.'}, deps, signal, owner, {'provider_status': 'FAILED'})
    url = outcome['generatedUrl']
    signal.check()
    try:
        # Native container and bytes are kept: MP4 for H.264, the .mov master for ProRes.
        saved = deps.save_magnific_video(url, video_extension({'url': url}), f'{item.id}/{uuid4().hex}', _metadata(item))
    except MediaTooLargeError:
        return _terminal(item, {'status': 'failed', 'error': MAGNIFIC_TOO_LARGE}, deps, Cancellation(30000), owner, {'provider_status': 'COMPLETED'})
    except Exception:
        if (item.poll_error_count or 0) + 1 >= MAGNIFIC_SAVE_ATTEMPTS:
            return _terminal(item, {'status': 'failed', 'error': MAGNIFIC_SAVE_FAILED}, deps, Cancellation(30000), owner, {'provider_status': 'COMPLETED'})
        raise
    # The master is stored: record it even if the job's own budget ran out meanwhile.
    return _terminal(item, {'status': 'succeeded', 'url': saved['url'], 'aspect_ratio': saved.get('aspectRatio') or item.aspect_ratio},
                     deps, Cancellation(30000), owner, {'provider_status': 'COMPLETED'})


def advance(item, *, source='cron', signal=None, owner=None, provider=None, callback_received_at=None, dependencies=None):
    if item.status in ('succeeded', 'failed'):
        return {'kind': item.status, 'item': item}
    if not item.task_id:
        return {'kind': 'pending', 'item': item}
    deps, signal = dependencies or Dependencies(), signal or Cancellation(60000)
    provider = dict(provider or {})
    if callback_received_at:
        provider['callback_received_at'] = callback_received_at
    try:
        signal.check()
        if item.model in magnific.MODELS:
            return advance_magnific(item, signal=signal, owner=owner, dependencies=deps)
        if item.model in magnific.VIDEO_MODELS:
            return advance_magnific_video(item, signal=signal, owner=owner, dependencies=deps)
        if deps.mock():
            if deps.now() - item.created_at <= 6000:
                return {'kind': 'pending', 'item': item}
            return _terminal(item, {'status': 'succeeded', 'url': item.poster}, deps, signal, owner, provider)
        if item.candidate_task_ids:
            return _best_of(item, deps, signal, owner, provider)
        is_omni = is_provider_model(item.model, 'omni')
        is_higgsfield = is_provider_model(item.model, 'higgsfield')
        get_status = deps.get_omni if is_omni else deps.get_higgsfield if is_higgsfield else deps.get_video
        result = get_status(item.task_id, signal=signal)
        provider.update(coordinator.provider_timestamps(result))
        if result['status'] == 'failed':
            blocked, message = (result.get('moderationBlocked'), result.get('error') or 'Generation failed.') if is_omni else _moderation(result.get('error'))
            return _terminal(item, {'status': 'failed', 'error': message, 'moderation_blocked': blocked}, deps, signal, owner, provider)
        if result['status'] != 'succeeded':
            return _pending(item, deps, signal, owner, {key: value for key, value in provider.items() if key != 'callback_received_at'}, 8000 if is_higgsfield else 5000)
        updates = {'status': 'succeeded'}
        if is_omni:
            if not result.get('videoBase64'):
                return _terminal(item, {'status': 'failed', 'error': 'Omni reported success but returned no video.'}, deps, signal, owner, provider)
            saved = None
            for attempt in range(2):
                signal.check()
                try:
                    saved = deps.save_base64(result['videoBase64'], 'webm' if 'webm' in (result.get('mimeType') or '') else 'mp4', f'{item.id}/{uuid4().hex}', _metadata(item))
                    break
                except Exception:
                    if attempt == 0:
                        signal.wait(1000)
            # Preserve completed provider work for a storage retry. Never label
            # an ephemeral provider URL as a durably saved production master.
            if saved is None:
                raise IOError('Video generated but durable storage is unavailable.')
        else:
            url = result.get('url') or result.get('videoUrl')
            if not url:
                return _terminal(item, {'status': 'failed', 'error': 'Provider reported success but returned no video.'}, deps, signal, owner, provider)
            signal.check()
            saved = deps.save_url(url, video_extension(result), f'{item.id}/{uuid4().hex}', _metadata(item))
            if (model_definition(item.model) or {}).get('usageCost') == 'seedance-token':
                cost = seedance_token_cost(item.model, result.get('totalTokens'), bool(item.reference_videos), deps.pricing())
                if cost is not None:
                    updates.update(cost_cents=cost, cost_basis='reconciled')
        updates.update(url=saved['url'], aspect_ratio=saved.get('aspectRatio') or item.aspect_ratio)
        return _terminal(item, updates, deps, signal, owner, provider)
    except Exception:
        return _poll_error(item, deps, owner)
