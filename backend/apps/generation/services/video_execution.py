"""Video submission with durable task receipts and ordered reference binding."""
import base64
import io
import math
import os
import re
from urllib.parse import parse_qsl, urlencode, unquote, urlsplit, urlunsplit

from django.conf import settings
from PIL import Image

from apps.assets.models import Asset
from apps.assets.views import serialize
from apps.assets.portrait_db import get_portrait_asset_by_image_url
from apps.common.leases import now_ms
from apps.generation.model_registry import is_provider_model, capability
from apps.generation.prompting.assembler import assemble_prompt
from apps.generation.prompting.image_prep import prep_reference
from apps.generation.providers import gemini, omni, seedance, omnihuman
from apps.integrations.transport import ProviderError
from apps.generation.references import asset_slugs, resolve_references, mention_indices, TOKEN_END
from apps.media.keys import media_key_from_ref
from apps.media.storage import get_storage
from apps.assets.provider_projection import provider_asset_projection


def read_assets(project_id=None):
    query = Asset.objects.all()
    if project_id:
        query = query.filter(project_id=project_id)
    return [provider_asset_projection(asset) for asset in query.order_by('-created_at')]


def callback_url(base, secret):
    if not isinstance(base, str) or not isinstance(secret, str) or not secret:
        return None
    try:
        parsed = urlsplit(base.strip())
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            return None
        query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != 'token']
        query.append(('token', secret))
        return urlunsplit(parsed._replace(query=urlencode(query)))
    except ValueError:
        return None


def remap_media_tags(prompt, videos=None, audios=None):
    for kind, refs in [('vid', videos or []), ('audio', audios or [])]:
        indices = [n for n in mention_indices(prompt, kind) if n <= len(refs)]
        mapping = {n: index + 1 for index, n in enumerate(indices)}
        prompt = re.sub('@' + kind + r'([1-9][0-9]*)' + TOKEN_END, lambda match: '@' + kind + str(mapping[int(match[1])]) if int(match[1]) in mapping else match[0], prompt, flags=re.I)
    return prompt


def combined_references(prompt, assets, uploads):
    by_slug = {asset['slug'].lower(): asset for asset in assets}
    by_image = {image: asset for asset in assets for image in asset.get('images') or []}
    result = []
    for slug in asset_slugs(prompt):
        asset = by_slug.get(slug)
        if asset and asset.get('images'):
            result.append({'tag': '@' + asset['slug'], 'slug': asset['slug'], 'kind': asset['kind'], 'name': asset['name'], 'imageUrl': asset['images'][0]})
    # Numeric indices belong to attachment occurrences, including an upload
    # that is also in the named catalog. Filtering first shifts their identity.
    for reference in resolve_references(prompt, uploads):
        result.append({'tag': reference['tag'], 'kind': 'image', 'imageUrl': reference['dataUrl']})
    if not result and uploads:
        for index, upload in enumerate(uploads):
            asset = by_image.get(upload)
            result.append({'tag': '@' + asset['slug'], 'slug': asset['slug'], 'kind': asset['kind'], 'name': asset['name'], 'imageUrl': upload} if asset else {'tag': f'@img{index+1}', 'kind': 'image', 'imageUrl': upload})
    return result


FACE_NOT_READY = 'A face reference was not ready as a portrait. Nothing was sent to the provider, so this was not charged.'
LOOKUP_UNAVAILABLE = 'Portrait registration lookup unavailable; submission stopped before provider execution.'
PORTRAIT_REMOVE_TAIL = 'Remove it from the references and try again; nothing was sent to the provider, so this was not charged.'
PORTRAIT_PROBLEMS = ('was removed from the Portrait Gallery', 'could not be prepared for video', 'is not ready for video yet')


def managed_reference(ref, read, managed):
    """Managed-portrait mode: return ('asset://id', None) for a pinned face asset, else (None, raw image)."""
    import hashlib
    from apps.assets.models import ReferenceFaceScan
    raw = read(ref.split('#', 1)[0] if isinstance(ref, str) else ref)
    sha = hashlib.sha256(base64.b64decode(raw['data'])).hexdigest()
    if sha in managed:
        return 'asset://' + managed[sha], None
    scan = ReferenceFaceScan.objects.filter(pk=sha).first()
    if scan is None or scan.has_face:
        # Never send a face (or an unscanned image) as raw pixels: BytePlus rejects it after billing.
        raise ValueError(FACE_NOT_READY)
    return None, raw


def to_provider_data_urls(references, signal, *, read=None, prepare=None, portrait_lookup=None, managed=None):
    read = read or get_storage().read_as_base64
    prepare = prepare or prep_reference
    portrait_lookup = portrait_lookup or get_portrait_asset_by_image_url
    output = []
    for ref in references:
        signal.check()
        if isinstance(ref, str) and ref.startswith('asset://'):
            output.append(ref)
            continue
        if managed is not None:
            asset, raw = managed_reference(ref, read, managed)
            if asset:
                output.append(asset)
                continue
            output.append(_data_url(raw, prepare))
            continue
        match = re.search(r'[?&#]bp[-_]asset(?:_id)?=([^&#]+)', ref) if isinstance(ref, str) else None
        if match:
            output.append('asset://' + unquote(match[1]))
            continue
        try:
            portrait = portrait_lookup(ref) if isinstance(ref, str) else None
        except Exception:
            # Without the lookup we cannot tell a Gallery portrait from a plain image.
            raise ValueError(LOOKUP_UNAVAILABLE) from None
        if portrait and portrait.get('byteplusAssetId') and (portrait.get('status') or '').lower() == 'active':
            output.append('asset://' + portrait['byteplusAssetId'])
            continue
        if portrait:
            # Sending an unregistered portrait as raw pixels trips BytePlus face filters and bills a doomed job.
            from .enqueue import portrait_reference_problem
            name = portrait.get('name')
            named = f'Portrait "{str(name)[:80]}"' if name else 'A Gallery portrait'
            problem = portrait_reference_problem(portrait) or 'is not ready for video yet'
            raise ValueError(f'{named} {problem}. ' + PORTRAIT_REMOVE_TAIL)
        output.append(_data_url(read(ref), prepare))
    return output


def _data_url(raw, prepare):
    prepared = prepare(raw['mimeType'], raw['data'])
    mime, data = prepared['mimeType'], prepared['data']
    if not re.fullmatch(r'image/(jpeg|png)', mime, re.I):
        try:
            with Image.open(io.BytesIO(base64.b64decode(data))) as image:
                buffer = io.BytesIO()
                image.convert('RGB').save(buffer, format='JPEG', quality=92)
                data, mime = base64.b64encode(buffer.getvalue()).decode(), 'image/jpeg'
        except Exception as error:
            raise ValueError(f'Reference image could not be converted to JPEG for Seedance (was {mime}).') from error
    return 'data:' + mime.lower() + ';base64,' + data


def sign_reference(ref, *, actor_id=None, seconds=900):
    key = media_key_from_ref(ref, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
    if key:
        return get_storage().signed_read_url(key, seconds=seconds, actor_id=actor_id)
    if isinstance(ref, str) and ref.startswith('https://'):
        return ref
    raise ValueError('Reference is not a stored media file or secure URL.')


class Dependencies:
    now = staticmethod(now_ms)
    assets = staticmethod(read_assets)
    assemble = staticmethod(assemble_prompt)
    inline = staticmethod(to_provider_data_urls)
    sign = staticmethod(sign_reference)
    seedance_submit = staticmethod(seedance.create_video_task)
    seedance_final = staticmethod(seedance.create_final_video_task)
    omnihuman_submit = staticmethod(omnihuman.create_video_task)
    omni_submit = staticmethod(omni.create_video_task)
    gemini_generate = staticmethod(gemini.generate_image)

    def read(self, ref):
        return get_storage().read_as_base64(ref)

    def prepare(self, mime, data):
        return prep_reference(mime, data)

    def upload_reference(self, data, key, ext):
        return get_storage().upload_base64(data, key, ext)

    def higgsfield_upload(self, data, mime, *, signal):
        from apps.generation.providers.higgsfield import upload_image
        return upload_image(data, mime, signal=signal)

    def higgsfield_submit(self, input, *, signal):
        from apps.generation.providers.higgsfield import generate_video
        return generate_video(input, signal=signal)


class ReferenceImageRejected(ValueError):
    pass


def verify_reference_image_sizes(item, combined, measure=None):
    """Fail the job, uncharged, when a Seedance image reference is under 300 px or outside the 0.4-2.5 ratio.

    The enqueue request checks the same rule within a time budget; this covers what it did not reach.
    """
    from apps.generation import image_limits
    measure = measure or image_limits.reference_dimensions
    labelled = [(ref['tag'], ref['imageUrl']) for ref in combined]
    labelled += [(label, ref) for label, ref in (('The first frame', item.continuation_frame_url), ('The last frame', item.last_frame_url)) if ref]
    for label, ref in labelled:
        size = measure(ref)
        if size and image_limits.seedance_problem(*size):
            raise ReferenceImageRejected(image_limits.seedance_message(label, *size, image_limits.WORKER_TAIL))


def submit_video(item, *, signal, on_task, count=1, dependencies=None, env=None):
    """on_task records every accepted ID before any later submission can fail.

    Serial submissions preserve the provider ordering and cap simultaneous
    charges; already accepted work stays recoverable after a partial failure.
    """
    deps, env = dependencies or Dependencies(), os.environ if env is None else env
    callbacks = callback_url(env.get('SEEDANCE_CALLBACK_URL'), env.get('SEEDANCE_CALLBACK_SECRET'))
    base = {'status': 'running', 'submitted_at': deps.now(), 'next_poll_at': deps.now() + 5000, 'poll_attempts': 0}
    if item.task_id:
        return base  # Recovery polls a receipt; it never submits again.
    if env.get('MOCK_GENERATION') == '1':
        from .mock import mock_placeholder
        poster = mock_placeholder(str(item.id), item.prompt, item.aspect_ratio, item.model)
        task_id = 'mock-' + str(item.id)
        on_task(task_id, 0, 1)
        return {**base, 'task_id': task_id, 'poster': poster}
    if item.draft_task_id:
        task_id = deps.seedance_final({'modelDisplay': item.model, 'draftTaskId': item.draft_task_id, 'callbackUrl': callbacks}, signal=signal)
        on_task(task_id, 0, 1)
        return {**base, 'task_id': task_id}
    if is_provider_model(item.model, 'omnihuman'):
        from .omnihuman_inputs import validate
        combined = combined_references(item.prompt, deps.assets(item.project_id), item.reference_images or [])
        images = [ref['imageUrl'] for ref in combined]
        audios = resolve_references(item.prompt, item.reference_audios or [], 'audio')
        seconds = validate(images, audios)
        if item.duration != math.ceil(seconds):
            raise ValueError('The OmniHuman audio changed after queueing. Attach it again before generating.')
        def signed(ref):
            return deps.sign(ref) if dependencies is not None else sign_reference(ref, actor_id=item.user_id, seconds=12 * 60 * 60)
        task_id = deps.omnihuman_submit({'prompt': item.prompt, 'imageUrls': [signed(ref.split('#', 1)[0]) for ref in images],
            'audioUrls': [signed(ref) for ref in audios]}, signal=signal)
        on_task(task_id, 0, 1)
        return {**base, 'task_id': task_id}
    if is_provider_model(item.model, 'omni'):
        assembled = deps.assemble(item.prompt, deps.assets(item.project_id), item.reference_images or [], {'aspectRatio': item.aspect_ratio, 'medium': 'video'})
        task_id = deps.omni_submit({'assembled': assembled, 'aspectRatio': item.aspect_ratio, 'duration': item.duration or 4,
                                    'resolution': item.resolution, 'modelDisplay': item.model}, signal=signal)
        on_task(task_id, 0, 1)
        return {**base, 'task_id': task_id}
    if is_provider_model(item.model, 'higgsfield'):
        refs, media_ids, extra = item.reference_images or [], [], {}
        if not refs:
            image = deps.gemini_generate({'assembled': {'instruction': item.prompt, 'groups': []}, 'aspectRatio': item.aspect_ratio}, signal=signal)
            signal.check()
            ext = image['mimeType'].split('/')[-1] or 'png'
            extra['reference_images'] = [deps.upload_reference(image['base64'], f'references/{item.id}-auto.{ext}', ext)]
            media_ids.append(deps.higgsfield_upload(image['base64'], image['mimeType'], signal=signal))
        else:
            for ref in refs:
                signal.check()
                raw = deps.read(ref)
                image = deps.prepare(raw['mimeType'], raw['data'])
                media_ids.append(deps.higgsfield_upload(image['data'], image['mimeType'], signal=signal))
        task_id = deps.higgsfield_submit({'model': item.model, 'prompt': item.prompt, 'aspectRatio': item.aspect_ratio,
            'duration': item.duration, 'resolution': item.resolution, 'mediaIds': media_ids}, signal=signal)
        on_task(task_id, 0, 1)
        return {**base, **extra, 'task_id': task_id}
    combined = combined_references(item.prompt, deps.assets(item.project_id), item.reference_images or [])
    from .portrait_prepare import applies as managed_applies, assets_for
    verify_reference_image_sizes(item, combined)       # before the first inline read or provider call: nothing is billed
    managed = {'managed': assets_for(item.id)} if managed_applies(item) else {}
    inlined = deps.inline([ref['imageUrl'] for ref in combined], signal, **managed)
    references = [{**ref, 'index': index + 1, 'dataUrl': inlined[index]} for index, ref in enumerate(combined)]
    videos, audios = [], []
    for ref in resolve_references(item.prompt, item.reference_videos or [], 'vid'):
        signal.check()
        try:
            videos.append(deps.sign(ref) if dependencies is not None else sign_reference(ref, actor_id=item.user_id))
        except Exception as error:
            raise ValueError('Reference clip could not be prepared for the provider. ' + str(error)) from error
    for ref in resolve_references(item.prompt, item.reference_audios or [], 'audio'):
        signal.check()
        audios.append(deps.sign(ref) if dependencies is not None else sign_reference(ref, actor_id=item.user_id))
    first = deps.inline([item.continuation_frame_url], signal, **managed)[0] if item.continuation_frame_url else None
    last = deps.inline([item.last_frame_url], signal, **managed)[0] if item.last_frame_url else None
    accepted, rejected = [], []
    for index in range(count):
        try:
            signal.check()
            input = {'prompt': remap_media_tags(item.prompt, item.reference_videos, item.reference_audios), 'modelDisplay': item.model,
                'ratio': item.aspect_ratio, 'resolution': item.resolution, 'duration': item.duration, 'references': references,
                'referenceVideoUrls': videos, 'referenceAudioUrls': audios, 'generateAudio': item.generate_audio is True,
                'draftMode': item.draft_mode is True, 'bitrateMode': item.bitrate_mode, 'taskMode': item.video_task_mode,
                'seed': item.seed + index if item.seed is not None else None,
                'firstFrame': {'dataUrl': first} if first else None, 'lastFrame': {'dataUrl': last} if last else None, 'callbackUrl': callbacks}
            task_id = deps.seedance_submit(input, signal=signal)
        except Exception as error:
            if getattr(error,'may_have_submitted',True) is not False:
                raise
            rejected.append(error)
            continue
        # Persistence failure is not a provider rejection and must stop further
        # billable submissions. Preserve the accepted receipt before checking
        # cancellation: the remote task exists even if the request ran late.
        on_task(task_id, index, count)
        accepted.append(task_id)
    if not accepted:
        if count == 1:
            raise rejected[0]
        first_error = rejected[0]
        raise ProviderError(f'Video candidate submission failed (0/{count} accepted): {first_error}',
            code=getattr(first_error, 'code', 'provider_error'), status=getattr(first_error, 'status', None),
            may_have_submitted=any(getattr(error, 'may_have_submitted', True) is not False for error in rejected),
            provider_response=[getattr(error, 'provider_response', None) for error in rejected if getattr(error, 'provider_response', None)])
    responses = [{**error.provider_response, 'model': item.model} for error in rejected if isinstance(getattr(error, 'provider_response', None), dict)]
    return {**base, 'task_id': accepted[0], 'candidate_task_ids': accepted[1:] if count > 1 else None,
            'cost_cents': math.floor(item.cost_cents / count * len(accepted) + .5),
            **({'provider_responses': responses} if responses else {})}
