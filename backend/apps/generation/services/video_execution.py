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
from apps.generation.providers import gemini, omni, seedance
from apps.generation.providers.transport import ProviderError
from apps.generation.references import asset_slugs, resolve_references, mention_indices, TOKEN_END
from apps.media.keys import media_key_from_ref
from apps.media.storage import get_storage


def read_assets(project_id=None):
    query = Asset.objects.all()
    if project_id:
        query = query.filter(project_id=project_id)
    return [serialize(asset) for asset in query.order_by('-created_at')]


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


def to_provider_data_urls(references, signal, *, read=None, prepare=None, portrait_lookup=None):
    read = read or get_storage().read_as_base64
    prepare = prepare or prep_reference
    portrait_lookup = portrait_lookup or get_portrait_asset_by_image_url
    output = []
    for ref in references:
        signal.check()
        if isinstance(ref, str) and ref.startswith('asset://'):
            output.append(ref)
            continue
        match = re.search(r'[?&#]bp[-_]asset(?:_id)?=([^&#]+)', ref) if isinstance(ref, str) else None
        if match:
            output.append('asset://' + unquote(match[1]))
            continue
        try:
            portrait = portrait_lookup(ref) if isinstance(ref, str) else None
        except Exception:
            # Without the lookup we cannot tell a Gallery portrait from a plain image.
            raise ValueError('Portrait registration lookup unavailable; submission stopped before provider execution.') from None
        if portrait and portrait.get('byteplusAssetId') and (portrait.get('status') or '').lower() == 'active':
            output.append('asset://' + portrait['byteplusAssetId'])
            continue
        if portrait:
            # Sending an unregistered portrait as raw pixels trips BytePlus face filters and bills a doomed job.
            raise ValueError('This Gallery portrait is not registered and Active in BytePlus. Register and verify the '
                             'existing portrait before Seedance submission; no generation was submitted.')
        raw = read(ref)
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
        output.append('data:' + mime.lower() + ';base64,' + data)
    return output


def sign_reference(ref, *, actor_id=None):
    key = media_key_from_ref(ref, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
    if key:
        return get_storage().signed_read_url(key, actor_id=actor_id)
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
    if is_provider_model(item.model, 'omni'):
        assembled = deps.assemble(item.prompt, deps.assets(item.project_id), item.reference_images or [], {'aspectRatio': item.aspect_ratio, 'medium': 'video'})
        task_id = deps.omni_submit({'assembled': assembled, 'aspectRatio': item.aspect_ratio, 'duration': item.duration or 4}, signal=signal)
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
    inlined = deps.inline([ref['imageUrl'] for ref in combined], signal)
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
    first = deps.inline([item.continuation_frame_url], signal)[0] if item.continuation_frame_url else None
    last = deps.inline([item.last_frame_url], signal)[0] if item.last_frame_url else None
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
            code=getattr(first_error, 'code', 'provider_error'), provider_response=[getattr(error, 'provider_response', None) for error in rejected if getattr(error, 'provider_response', None)])
    responses = [getattr(error, 'provider_response', None) for error in rejected if getattr(error, 'provider_response', None)]
    return {**base, 'task_id': accepted[0], 'candidate_task_ids': accepted[1:] if count > 1 else None,
            'cost_cents': math.floor(item.cost_cents / count * len(accepted) + .5),
            **({'provider_responses': responses} if responses else {})}
