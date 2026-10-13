"""Reusable material catalog; stable slugs and the existing one-image contract."""
import re
from uuid import uuid4

from django.db import transaction
from rest_framework.response import Response

from apps.common.leases import now_ms
from apps.common.responses import log_activity
from apps.generation.watermark import WHITESPACE
from apps.library.views import body_or_empty
from .models import Asset

ASSET_KINDS = ('character', 'prop', 'location', 'style', 'outfit', 'audio', 'other')


def sanitize_slug(name):
    base = re.sub(r'[^a-z0-9]+', '-', name.lower().strip(WHITESPACE)).strip('-')[:32] or 'asset'
    return 'asset-' + base if re.fullmatch(r'(img|image|vid|video|audio)[0-9]+', base) else base


def unique_slug(name, exclude_id=None, project_id=None):
    base = sanitize_slug(name)
    query = Asset.objects.all()
    if project_id:
        query = query.filter(project_id=project_id)
    if exclude_id:
        query = query.exclude(pk=exclude_id)
    taken = set(query.values_list('slug', flat=True))
    candidate, number = base, 2
    while candidate in taken:
        candidate, number = f'{base}-{number}', number + 1
    return candidate


def save_catalog_asset(request, actor):
    from apps.media.images import save_asset_image, delete_asset_image
    from .views import serialize
    from apps.media.uploads import resolve_ready_upload, UploadError
    from apps.media.models import UploadSession
    from apps.media.keys import media_key_from_ref
    from django.conf import settings
    data = body_or_empty(request)
    try:
        name = (data.get('name') or '').strip(WHITESPACE)
        description = (data.get('description') or '').strip(WHITESPACE)
        kind = data.get('kind')
        if not name:
            return Response({'error': 'Name is required.'}, status=400)
        if kind not in ASSET_KINDS:
            return Response({'error': 'Invalid asset kind.'}, status=400)
        inputs = (data['images'] if isinstance(data.get('images'), list) else
                  [data['image']] if data.get('image') else [data['imageUrl']] if data.get('imageUrl') else [])
        if not inputs and not data.get('id'):
            return Response({'error': 'A reference image is required for this material.'}, status=400)
        existing = Asset.objects.filter(pk=data['id']).first() if data.get('id') else None
        images = []
        for value in inputs:
            if isinstance(value, dict):
                from uuid import UUID
                try:
                    reference_id = UUID(str(value.get('referenceId', '')))
                except ValueError:
                    raise UploadError('INVALID_REFERENCE_ID') from None
                row = resolve_ready_upload(actor.id, reference_id, purposes={'material'})
                images.append('/api/media/' + row.key)
                continue
            if not isinstance(value, str) or not value.strip(WHITESPACE):
                continue
            if existing and value.strip(WHITESPACE) in (existing.images or []):
                images.append(value.strip(WHITESPACE))
                continue
            key = media_key_from_ref(value.strip(WHITESPACE), getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
            row = UploadSession.objects.filter(key=key).first() if key and key.startswith('uploads/') else None
            if row:
                row = resolve_ready_upload(actor.id, str(row.id), purposes={'material'})
                images.append('/api/media/' + row.key)
                continue
            images.append(save_asset_image(value) if value.startswith('data:') else value.strip(WHITESPACE))
        if not images and existing and existing.images:
            images.extend(existing.images)
        if not images:
            return Response({'error': 'A reference image is required for this material.'}, status=400)
        project_id = data.get('projectId') or (existing.project_id if existing else None)
        slug = (unique_slug(data['slug'], existing.id if existing else None, project_id) if data.get('slug') else
                existing.slug if existing else unique_slug(name, project_id=project_id))
        now = now_ms()
        with transaction.atomic():
            asset, _ = Asset.objects.update_or_create(pk=existing.id if existing else uuid4(), defaults={
                'created_by_id': existing.created_by_id if existing else actor.id,
                'name': name, 'kind': kind, 'slug': slug, 'description': description or None,
                'images': images[:1], 'project_id': project_id,
                'created_at': existing.created_at if existing else now, 'updated_at': now})
        # Keep the old media until the replacement is durably committed.
        # A write/commit failure must leave the persisted catalog usable.
        if existing:
            for old in existing.images or []:
                if old not in images:
                    delete_asset_image(old)
        detail = {'assetId': str(asset.id), 'name': asset.name, 'kind': asset.kind, 'slug': asset.slug}
        if asset.project_id:
            detail['projectId'] = str(asset.project_id)
        log_activity(actor.id, 'update_asset' if existing else 'create_asset', detail)
        return Response(serialize(asset))
    except UploadError as error:
        return Response({'error': error.code}, status=error.status)
    except Exception:
        return Response({'error': 'Failed to save material asset.'}, status=500)


def delete_catalog_asset(request, actor):
    from apps.media.images import delete_asset_image
    values = request.query_params.getlist('id')
    identifier = values[0] if values else None
    if not identifier:
        return Response({'error': 'Missing id.'}, status=400)
    with transaction.atomic():
        asset = Asset.objects.filter(pk=identifier).first()
        if asset:
            asset.delete()
    if asset:
        for image in asset.images or []:
            delete_asset_image(image)
        log_activity(actor.id, 'delete_asset', {'id': identifier, 'slug': asset.slug, 'name': asset.name, 'kind': asset.kind})
    return Response({'ok': True})
