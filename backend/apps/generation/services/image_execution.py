"""Provider image execution; the caller owns task receipts and fenced DB writes."""
import base64
import math
import os
import random
import tempfile
import time
from pathlib import Path
from uuid import uuid4

from apps.common.leases import now_ms
from apps.generation.model_registry import model_definition, capability
from apps.generation.prompting.assembler import assemble_prompt
from apps.generation.prompting import image_prep, face_judge
from apps.generation.providers import gemini, kling, seedream, higgsfield
from apps.media.persistence import measure_generated_media
from apps.integrations.remote import get_media_fetcher
from apps.media.storage import get_storage
from .pricing import read_pricing, compute_cost, kling_units_to_cents
from .seedream_references import prepare_seedream_references


def read_assets(project_id=None):
    from apps.assets.models import Asset
    from apps.assets.provider_projection import provider_asset_projection
    query = Asset.objects.all()
    if project_id:
        query = query.filter(project_id=project_id)
    return [provider_asset_projection(asset) for asset in query.order_by('-created_at')]


class Dependencies:
    """Override methods or supply materialized assets/pricing before timed work."""
    assets = None
    pricing = None
    read_assets = staticmethod(read_assets)
    read_pricing = staticmethod(read_pricing)
    storage = staticmethod(get_storage)
    fetcher = staticmethod(lambda url: get_media_fetcher()(url))
    now = staticmethod(now_ms)
    monotonic = staticmethod(time.monotonic)
    random_seed = staticmethod(lambda: random.randrange(2147483647))
    assemble = staticmethod(assemble_prompt)
    prepare = staticmethod(image_prep.prep_reference)
    crispen = staticmethod(image_prep.crispen)
    seedream_resolve = staticmethod(seedream.resolve_seedream_references)
    seedream_prepare = staticmethod(prepare_seedream_references)
    seedream_generate = staticmethod(seedream.generate_image)
    gemini_generate = staticmethod(gemini.generate_image)
    kling_build = staticmethod(kling.build_input)
    kling_prepare = staticmethod(kling.prep_reference)
    kling_submit = staticmethod(kling.submit_image)
    kling_resolve = staticmethod(kling.resolve_image)
    higgsfield_upload = staticmethod(higgsfield.mcp_upload_image)
    higgsfield_submit = staticmethod(higgsfield.mcp_generate_image)
    higgsfield_await = staticmethod(higgsfield.mcp_await_job)
    judge_identity = staticmethod(face_judge.judge_identity)
    judge_candidate = staticmethod(face_judge.judge_candidate)
    temporary_directory = staticmethod(tempfile.TemporaryDirectory)

    def mock_placeholder(self, identifier, prompt, aspect_ratio, model):
        from .mock import mock_placeholder
        return mock_placeholder(identifier, prompt, aspect_ratio, model)


def task_ended(result, fallback, provider, task_id):
    """An accepted task the provider ended without a usable image. A definitive end (failed, or done with no image)
    fails the job; only our own wait running out (Higgsfield's await timeout) leaves it to be polled again."""
    from apps.generation import provider_errors
    from apps.generation.providers.transport import ProviderError
    message = result.get('error') or fallback
    record = result.get('providerError') or provider_errors.capture(provider, phase='task', message=message, task_id=task_id)
    error = ProviderError(message, code='task_failed', provider_response=record)
    error.terminal = record.get('source') != 'veevee'
    return error


def bounded_best_of(configured, image_size):
    try:
        requested = float(configured or 2)
        if math.isnan(requested) or requested == 0:
            requested = 2
    except (ValueError, TypeError):
        requested = 2
    return math.ceil(min(max(requested, 1), 4, {'1K': 4, '2K': 3, '4K': 2}.get(image_size, 2)))


def execute_image(item, *, signal, dependencies=None, env=None, on_task=None):
    """Return snakecase success fields without mutating a generation row.

    on_task(task_id) must durably record an accepted external task before it
    returns. A stored task_id resumes polling and never submits a duplicate.
    """
    deps, env = dependencies or Dependencies(), os.environ if env is None else env
    signal.check()
    identifier, model = str(item.id), item.model
    prompt, ratio, resolution = item.prompt, item.aspect_ratio, item.resolution
    references = item.reference_images or []
    definition = model_definition(model) or {}
    provider = definition.get('provider')
    seed = item.seed
    if seed is None and capability(model, 'seed') and not getattr(item, 'draft_task_id', None):
        seed = deps.random_seed()
    cost, basis, judge_score = item.cost_cents or 0, 'reconciled' if item.cost_basis == 'reconciled' else 'estimated', None
    metadata = {'kind': 'image', 'model': model, 'requestedAspectRatio': ratio,
                'supportedRatios': capability(model, 'aspectRatios', None)}

    def save(data, ext):
        signal.check()
        # A stale worker may finish uploading after another worker wins the DB
        # fence. Distinct immutable objects keep its bytes off the winner's URL.
        url = deps.storage().upload_buffer(data, f'generations/{identifier}/{uuid4().hex}.{ext}', ext)
        signal.check()
        return {'url': url, **measure_generated_media(data, ext, metadata)}

    def fetch(url):
        signal.check()
        result = deps.fetcher(url)
        signal.check()
        return result[0] if isinstance(result, tuple) else result

    def assets():
        return deps.assets if deps.assets is not None else deps.read_assets(item.project_id)

    def assemble(with_ratio=True):
        result = deps.assemble(prompt, assets(), references, {'aspectRatio': ratio} if with_ratio else {},
            read_image=deps.storage().read_as_base64, prep_reference=deps.prepare,
            analyze_identity=lambda mime, data, limit=3: image_prep.analyze_identity_reference(mime, data, limit, env=env, signal=signal),
            detect_role=lambda mime, data: image_prep.detect_reference_role(mime, data, env=env, signal=signal), env=env)
        signal.check()
        return result

    def receipt(task_id):
        # Persist an accepted task even if cancellation raced the submission.
        if on_task:
            on_task(task_id)
        signal.check()
        return task_id

    if env.get('MOCK_GENERATION') == '1':
        signal.wait(700)
        saved = {'url': deps.mock_placeholder(identifier, prompt, ratio, model), 'aspectRatio': ratio}
    elif provider == 'seedream':
        assembled = deps.seedream_resolve(prompt, assets(), references)
        prepared = deps.seedream_prepare(assembled['references'], identifier, signal=signal, user_id=item.user_id)
        data = deps.seedream_generate({'prompt': assembled['prompt'], 'aspectRatio': ratio,
            'resolution': resolution, 'references': prepared['urls']}, signal=signal, env=env)
        saved = save(data, 'png')
        if not saved.get('width') or not saved.get('height'):
            raise ValueError('Seedream output dimensions could not be read.')
        pricing = deps.pricing if deps.pricing is not None else deps.read_pricing()
        cost = compute_cost({'model': model, 'width': saved['width'], 'height': saved['height'],
            'referenceCount': len(prepared['stable'])}, pricing)
        basis = 'estimated'
    elif provider == 'higgsfield':
        task_id = item.task_id
        if not task_id:
            assembled = assemble(False)
            nano = definition.get('higgsfieldTool') == 'nano-banana'
            media_ids = []
            for ref in references if nano else references[:1]:
                signal.check()
                raw = deps.storage().read_as_base64(ref)
                prepared = deps.prepare(raw['mimeType'], raw['data'])
                media_ids.append(deps.higgsfield_upload(prepared['data'], prepared['mimeType'], signal=signal))
            payload = {'model': model, 'prompt': assembled['instruction'], 'aspectRatio': ratio,
                       'mediaIds': media_ids or None}
            payload.update({'resolution': (resolution or '2K').lower()} if nano else {'quality': '1.5k' if resolution == '1K' else '2k'})
            task_id = receipt(deps.higgsfield_submit(payload, signal=signal))
        done = deps.higgsfield_await(task_id, signal=signal)
        if done.get('status') != 'succeeded' or not done.get('url'):
            raise task_ended(done, 'Higgsfield image generation failed.', 'higgsfield', task_id)
        saved = save(fetch(done['url']), 'png')
    elif provider == 'kling':
        task_id = item.task_id
        if not task_id:
            built = deps.kling_build(assemble(), model)
            ref = built.get('reference')
            refs = [deps.kling_prepare(ref['mimeType'], ref['data'])] if ref else []
            task_id = receipt(deps.kling_submit({'model': model, 'prompt': built['prompt'],
                'aspectRatio': ratio, 'resolution': resolution, 'references': refs}, signal=signal, env=env))
        deadline = deps.monotonic() + 240
        while True:
            signal.check()
            if deps.monotonic() >= deadline:
                raise TimeoutError('Kling image generation timed out.')
            done = deps.kling_resolve(task_id, signal=signal, env=env)
            if done.get('status') == 'succeeded':
                break
            if done.get('status') == 'failed':
                raise task_ended(done, 'Kling image generation failed.', 'kling', task_id)
            signal.wait(3000)
        reconciled = kling_units_to_cents(done.get('unitDeduction'))
        if reconciled is not None:
            cost, basis = reconciled, 'reconciled'
        saved = save(fetch(done['url']), 'png')
    else:
        assembled = assemble()
        size = '4K' if resolution == '4K' else '2K' if resolution in ('2K', '1080p') else '1K'
        payload = {'assembled': assembled, 'aspectRatio': ratio, 'imageSize': size, 'modelDisplay': model, 'seed': seed}
        count = bounded_best_of(env.get('FACE_BEST_OF'), size) if assembled.get('judgeFace') else 1
        if count > 1:
            with deps.temporary_directory(prefix='veevee-best-of-') as directory:
                candidates, errors = [], []
                for index in range(count):
                    signal.check()
                    try:
                        result = deps.gemini_generate({**payload, 'seed': seed + index if seed is not None else None}, signal=signal, env=env)
                        signal.check()
                        path = Path(directory) / f'candidate-{index}.bin'
                        path.write_bytes(base64.b64decode(result['base64'], validate=True))
                        candidates.append((path, result['mimeType']))
                        del result
                    except Exception as error:
                        signal.check()
                        errors.append(error)
                if not candidates:
                    raise errors[0] if errors else RuntimeError('Image generation failed.')
                cost *= len(candidates)
                composite = env.get('JUDGE_COMPOSITE') == '1'
                judge = deps.judge_candidate if composite else deps.judge_identity
                scores = []
                for path, mime in candidates:
                    signal.check()
                    candidate = {'mimeType': mime, 'data': base64.b64encode(path.read_bytes()).decode()}
                    scores.append(judge(assembled['judgeFace'], candidate, signal=signal, env=env))
                    del candidate
                best = face_judge.select_best_candidate(scores, 8) if composite else max(range(len(scores)), key=lambda index: scores[index] if scores[index] is not None else -1)
                judge_score = scores[best] if composite else {'identity': scores[best]} if scores[best] is not None else None
                path, mime = candidates[best]
                encoded = base64.b64encode(path.read_bytes()).decode()
        else:
            result = deps.gemini_generate(payload, signal=signal, env=env)
            encoded, mime = result['base64'], result['mimeType']
        if env.get('POST_CRISPEN') == '1':
            signal.check()
            sharpened = deps.crispen(mime, encoded)
            encoded, mime = sharpened['data'], sharpened['mimeType']
        saved = save(base64.b64decode(encoded, validate=True), 'jpg' if 'jpeg' in mime else 'png')
    signal.check()
    return {'status': 'succeeded', 'url': saved['url'], 'aspect_ratio': saved['aspectRatio'],
            'cost_cents': cost, 'cost_basis': basis, 'seed': seed, 'judge_score': judge_score, 'updated_at': deps.now()}
