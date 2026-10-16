"""Deterministic reference tags; no provider calls or prompt paraphrasing."""
import re

FLAGS = re.I | re.ASCII
TAG = re.compile(r'@([a-z][a-z0-9_-]*)', FLAGS)
TOKEN_END = r'(?![a-z0-9_-])'


class InvalidReference(ValueError):
    pass


def image_typo(slug):
    """Reserved image spellings are text, never guessed material identities."""
    return bool(re.fullmatch(r'(?:img|imgg|image|pic)[0-9a-z_-]*', slug, FLAGS))


def reference_warnings(prompt, uploads=None, assets=None):
    known = {asset['slug'].lower() for asset in assets or []}
    count = len(uploads or [])
    warnings = []
    for match in TAG.finditer(prompt or ''):
        slug = match[1].lower()
        canonical = re.fullmatch(r'img([1-9][0-9]*)', slug)
        if slug not in known and image_typo(slug) and (not canonical or int(canonical[1]) > count):
            warnings.append({'code': 'REFERENCE_TOKEN_LITERAL', 'token': match[0],
                'message': f'{match[0]} has no attached image match and will remain literal prompt text.'})
    return warnings


def resolve_submission_references(body, actor_id):
    """Resolve verified small upload manifests before any generation is queued.

    Legacy references remain compatible. New private upload-session URLs cannot
    bypass readiness/ownership by replacing a manifest with its canonical URL.
    Published material/portrait access follows the existing shared catalog.
    """
    from apps.media.keys import media_key_from_ref, is_export_key
    from apps.media.models import UploadSession
    from apps.media.uploads import resolve_ready_upload
    from django.conf import settings
    purposes = {'referenceImages': ('image-reference', 'portrait', 'material', 'canvas'),
        'image': ('image-reference', 'portrait', 'material', 'canvas'),
        'referenceVideos': ('video-reference',), 'referenceAudios': ('audio-reference',),
        'video': ('video-reference',),
        'firstFrame': ('image-reference', 'portrait', 'material', 'canvas'),
        'lastFrame': ('image-reference', 'portrait', 'material', 'canvas'),
        'continuationFrame': ('image-reference', 'portrait', 'material', 'canvas')}

    def resolve(value, allowed):
        if isinstance(value, dict):
            identifier = value.get('referenceId')
            if not isinstance(identifier, str) or not identifier:
                raise InvalidReference('An uploaded reference must include its referenceId.')
            import uuid
            try:
                uuid.UUID(identifier)
            except ValueError:
                raise InvalidReference('Invalid uploaded referenceId.') from None
            row = resolve_ready_upload(actor_id, identifier, purposes=allowed)
            return '/api/media/' + row.key
        if isinstance(value, str):
            key = media_key_from_ref(value, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
            if key and is_export_key(key):
                raise InvalidReference('Export archives cannot be used as media references.')
            row = UploadSession.objects.filter(key=key).first() if key and key.startswith('uploads/') else None
            if row:
                if row.finalized_at and row.state == 'ready' and row.purpose in ('portrait', 'material'):
                    from apps.assets.models import Asset, PortraitAsset
                    canonical = '/api/media/' + row.key
                    published = Asset.objects.filter(images__contains=[canonical]).exists() if row.purpose == 'material' else PortraitAsset.objects.filter(image_url=canonical).exists()
                    if published:
                        if row.purpose not in allowed:
                            from apps.media.uploads import UploadError
                            raise UploadError('UPLOAD_PURPOSE_MISMATCH', 403)
                        return canonical
                row = resolve_ready_upload(actor_id, str(row.id), purposes=allowed)
                return '/api/media/' + row.key
        return value

    result = dict(body)
    for field, allowed in purposes.items():
        if field not in result:
            continue
        value = result[field]
        result[field] = [resolve(ref, allowed) for ref in value] if isinstance(value, list) else resolve(value, allowed)
    return result


def normalize_mentions(prompt):
    if not isinstance(prompt, str):
        return prompt or ''
    rules = [(r'@(image|pic)[\s_-]*([0-9]+)(?![0-9])', r'@img\2'),
             (r'@img[\s_-]+([0-9]+)(?![0-9])', r'@img\1'),
             (r'@video[\s_-]*([0-9]+)(?![0-9])', r'@vid\1'),
             (r'@vid[\s_-]+([0-9]+)(?![0-9])', r'@vid\1'),
             (r'@audio[\s_-]+([0-9]+)(?![0-9])', r'@audio\1')]
    for pattern, replacement in rules:
        prompt = re.sub(pattern, replacement, prompt, flags=FLAGS)
    return prompt


def asset_slugs(prompt):
    result = []
    for match in TAG.finditer(prompt or ''):
        slug = match[1].lower()
        if not re.fullmatch(r'(img|image|vid|video|audio)[0-9]+', slug) and slug not in result:
            result.append(slug)
    return result


def mention_indices(prompt, kind='img'):
    return sorted({int(value) for value in re.findall('@' + re.escape(kind) + r'([1-9][0-9]*)' + TOKEN_END,
                  prompt or '', flags=FLAGS)})


def resolve_references(prompt, uploads, kind='img'):
    if not uploads:
        return []
    indices = [n for n in mention_indices(prompt, kind) if n <= len(uploads)] or range(1, len(uploads)+1)
    if kind != 'img':
        return [uploads[n-1] for n in indices]
    return [{'tag': f'@img{n}', 'index': n, 'dataUrl': uploads[n-1]} for n in indices]
