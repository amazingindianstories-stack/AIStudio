"""Single-submit Seedream image adapter and exact reference/dimension rules."""
import os
import re
from apps.generation.model_registry import provider_model_id
from apps.generation.references import asset_slugs, mention_indices, TAG, FLAGS, TOKEN_END, image_typo, reference_warnings
from .transport import HttpTransport, ProviderError, required_key

SEEDREAM_SIZES = {
    '1K': {'1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1568x672'},
    '1.5K': {'1:1': '1536x1536', '4:3': '1792x1344', '3:4': '1344x1792', '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248', '2:3': '1248x1872', '21:9': '2352x1008'},
    '2K': {'1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368', '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344'},
}


def seedream_size(resolution='2K', aspect_ratio='1:1'):
    size = SEEDREAM_SIZES.get(resolution, {}).get(aspect_ratio)
    if size is None:
        raise ValueError('Seedream 5.0 Pro requires 1K, 1.5K, or 2K and a supported aspect ratio.')
    return size


def resolve_seedream_references(prompt, assets=None, uploads=None):
    assets = assets or []
    uploads = [] if uploads is None else uploads
    if not isinstance(uploads, list) or any(not isinstance(value, str) or not value for value in uploads):
        raise ValueError('Invalid reference images. Upload the images again.')
    groups = []
    for slug in asset_slugs(re.sub(r'@img[0-9]+\b', '', prompt, flags=FLAGS)):
        asset = next((value for value in assets if value['slug'].lower() == slug), None)
        if not asset and image_typo(slug):
            continue
        if not asset or not asset.get('images'):
            raise ValueError(f'Missing reference @{slug}. Attach the asset or remove its tag.')
        role = f"{asset['kind']}: {asset['name']}" + (' — ' + asset['description'] if asset.get('description') else '')
        groups.append({'tag': slug, 'refs': asset['images'], 'role': role})
    tagged = mention_indices(prompt)
    tagged = [n for n in tagged if n <= len(uploads)]
    for n in tagged or range(1, len(uploads) + 1):
        groups.append({'tag': f'img{n}', 'refs': [uploads[n-1]], 'role': 'use as instructed in the prompt'})
    references, names, legend = [], {}, []
    for group in groups:
        labels = []
        for value in group['refs']:
            references.append(value)
            labels.append(f'image {len(references)}')
        images = ', '.join(labels)
        names[group['tag']] = images
        legend.append(images + ': ' + group['role'])
    if len(references) > 10:
        raise ValueError(f'Seedream 5.0 Pro accepts at most 10 resolved images; this prompt resolves to {len(references)}. Reduce uploads or named asset images.')
    rewritten = re.sub(r'@img([1-9][0-9]*)' + TOKEN_END, lambda m: names.get(f'img{int(m[1])}', m[0]), prompt, flags=FLAGS)
    rewritten = TAG.sub(lambda m: names.get(m[1].lower(), m[0]), rewritten)
    if legend:
        rewritten = "References:\n" + '\n'.join(legend) + "\nFollow the user's editing instructions, including any requested changes to the references.\n\n" + rewritten
    result = {'references': references, 'prompt': rewritten}
    warnings = reference_warnings(prompt, uploads, assets)
    if warnings:
        result['warnings'] = warnings
    return result


def seedream_payload(input, env=None):
    if not input.get('prompt', '').strip():
        raise ValueError('Prompt is required.')
    references = input.get('references', [])
    if len(references) > 10:
        raise ValueError('Seedream accepts at most 10 references.')
    payload = {'model': provider_model_id('seedream-5-pro', env), 'prompt': input['prompt'],
               'size': seedream_size(input.get('resolution', '2K'), input.get('aspectRatio', '1:1')),
               'response_format': 'url', 'output_format': 'png', 'watermark': False,
               'optimize_prompt_options': {'mode': 'standard'}}
    if references:
        payload['image'] = references
    return payload


def generate_image(input, *, transport=None, env=None, signal=None, fetcher=None):
    env = os.environ if env is None else env
    key = required_key(env, 'ARK_API_KEY', 'Seedream is not configured: ARK_API_KEY is missing or redacted.')
    payload = seedream_payload(input, env)
    transport = transport or HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com'])
    endpoint = env.get('ARK_BASE_URL', 'https://ark.ap-southeast.bytepluses.com/api/v3').rstrip('/')
    try:
        response = transport.request('POST', endpoint + '/images/generations',
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, body=payload, signal=signal)
    except Exception as error:
        if signal:
            signal.check()
        raise ProviderError('Seedream connection ended without a confirmed result. The request may have been charged; it was not resubmitted.',
                            code='ambiguous_submission') from error
    try:
        result = response.json()
    except ValueError:
        result = None
    if not response.ok or (result or {}).get('error'):
        code = re.sub(r'[^a-zA-Z0-9_.-]', '', str(((result or {}).get('error') or {}).get('code', 'provider_error')))[:100]
        message = ('Enable Seedream 5.0 Pro in this account’s ModelArk console.' if code == 'ModelNotOpen' else
                   'Seedream rate limit reached. Try again later.' if response.status == 429 else
                   'Seedream authentication or model access failed.' if response.status in (401, 403) else
                   'Seedream rejected the request. Check reference files and content requirements.')
        raise ProviderError(f'{message} ({response.status}, {code})', code=code, status=response.status)
    data = (result or {}).get('data') or []
    url = data[0].get('url') if len(data) == 1 and isinstance(data[0], dict) else None
    if not isinstance(url, str) or not url.startswith('https://'):
        raise ProviderError('Seedream returned no valid single-image result. The request was not resubmitted.')
    if signal:
        signal.check()
    if fetcher is None:
        from apps.media.remote import get_media_fetcher
        fetcher = get_media_fetcher()
    try:
        content = fetcher(url)
    except Exception as error:
        raise ProviderError('Seedream produced an image but download failed. The request was not resubmitted.', code='output_download_failed') from error
    if signal:
        signal.check()
    return content[0] if isinstance(content, tuple) else content
