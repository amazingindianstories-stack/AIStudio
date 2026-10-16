"""Portrait identities and public shapes shared by routes and generation adapters."""
from .provider_projection import provider_portrait_projection
import re
import uuid
from urllib.parse import urlsplit
from django.db import transaction
from django.db.models import Q
from apps.library.services.idempotency import acquire_scope_locks, now_ms
from .models import PortraitGroup, PortraitAsset
from apps.authentication.models import User


def group_json(row):
    result = {'id': str(row.id), 'name': row.name, 'groupType': row.group_type,
        'projectName': row.project_name, 'createdAt': row.created_at, 'updatedAt': row.updated_at}
    for field, key in [('byteplus_group_id', 'byteplusGroupId'), ('description', 'description'),
                       ('primary_asset_id', 'primaryAssetId'), ('project_id', 'projectId')]:
        value = getattr(row, field)
        if value is not None:
            result[key] = str(value) if isinstance(value, uuid.UUID) else value
    return result


def asset_json(row):
    result = {'id': str(row.id), 'groupId': str(row.group_id), 'assetType': row.asset_type,
        'role': row.role, 'imageUrl': row.image_url, 'status': row.status,
        'createdAt': row.created_at, 'updatedAt': row.updated_at}
    for field, key in [('byteplus_asset_id', 'byteplusAssetId'), ('name', 'name'), ('status_message', 'statusMessage')]:
        value = getattr(row, field)
        if value is not None:
            result[key] = value
    creator = User.objects.filter(pk=row.created_by_id, is_active=True).first() if row.created_by_id else None
    result['uploader'] = {'id': str(creator.id), 'name': creator.name, 'avatarUrl': creator.avatar_url} if creator else None
    if row.created_by_id:
        result['createdById'] = str(row.created_by_id)
    return result


def uuid_or_none(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        return None


def with_assets(row, assets):
    return {**group_json(row), 'assets': assets, 'activeCount': sum(a['status'] == 'Active' for a in assets),
        'processingCount': sum(a['status'] == 'Processing' for a in assets)}


def list_portrait_groups(project_id=None):
    groups = PortraitGroup.objects.all()
    if project_id:
        groups = groups.filter(Q(project_id=project_id) | Q(project_id=None))
    groups = list(groups.order_by('-created_at', 'id'))
    grouped = {}
    for row in PortraitAsset.objects.filter(group_id__in=[g.id for g in groups]).order_by('created_at', 'id'):
        grouped.setdefault(row.group_id, []).append(asset_json(row))
    return [with_assets(group, grouped.get(group.id, [])) for group in groups]


def get_portrait_group(identifier):
    parsed = uuid_or_none(identifier)
    row = PortraitGroup.objects.filter(pk=parsed).first() if parsed else None
    return with_assets(row, list_portrait_assets(row.id)) if row else None


def get_portrait_group_by_byteplus_id(identifier):
    if not identifier:
        return None
    row = PortraitGroup.objects.filter(byteplus_group_id=identifier).first()
    return group_json(row) if row else None


@transaction.atomic
def upsert_portrait_group(group):
    identifier = group['id']
    bp_id = group.get('byteplusGroupId')
    acquire_scope_locks('portrait-group:' + str(identifier), *(['portrait-bp-group:' + bp_id] if bp_id else []))
    if bp_id and PortraitGroup.objects.filter(byteplus_group_id=bp_id).exclude(pk=identifier).exists():
        error = ValueError('BytePlus group identity already belongs to another local group; reconciliation required.')
        error.code = 'PORTRAIT_IDENTITY_CONFLICT'
        raise error
    now = now_ms()
    PortraitGroup.objects.update_or_create(pk=identifier, defaults={
        'byteplus_group_id': bp_id, 'name': group['name'], 'description': group.get('description'),
        'group_type': group.get('groupType') or 'AIGC', 'project_name': group.get('projectName') or 'default',
        'primary_asset_id': group.get('primaryAssetId'), 'project_id': group.get('projectId'),
        'created_at': group.get('createdAt') or now, 'updated_at': group.get('updatedAt') or now})
    return get_portrait_group(identifier)


def list_portrait_assets(group_id):
    return [asset_json(row) for row in PortraitAsset.objects.filter(group_id=group_id).order_by('created_at', 'id')]


def list_all_portrait_assets(project_id=None):
    assets = PortraitAsset.objects.all()
    if project_id:
        assets = assets.filter(Q(group__project_id=project_id) | Q(group__project_id=None))
    return [asset_json(row) for row in assets.order_by('-created_at', 'id')]


def get_portrait_asset(identifier):
    parsed = uuid_or_none(identifier)
    row = PortraitAsset.objects.filter(pk=parsed).first() if parsed else None
    return asset_json(row) if row else None


def get_portrait_asset_by_byteplus_id(identifier):
    if not identifier:
        return None
    row = PortraitAsset.objects.filter(byteplus_asset_id=identifier).first()
    return asset_json(row) if row else None


def get_portrait_asset_by_image_url(image_url):
    if not isinstance(image_url, str) or not image_url:
        return None
    try:
        parsed = urlsplit(image_url)
    except ValueError:
        return None
    clean = parsed._replace(query='', fragment='').geturl()
    path = parsed.path
    if not path or path == '/':
        return None
    exact, migrated = [], []
    # The SQL filter narrows candidates only; identity comparison uses complete
    # parsed URLs/paths so a suffix or embedded subpath cannot borrow a portrait.
    for row in PortraitAsset.objects.filter(Q(image_url__startswith=clean) | Q(image_url__contains=path)):
        try:
            stored = urlsplit(row.image_url)
        except ValueError:
            continue
        if stored._replace(query='', fragment='').geturl() == clean:
            exact.append(row)
        if stored.path == path:
            migrated.append(row)
    matches = exact if exact else migrated
    return provider_portrait_projection(matches[0]) if len(matches) == 1 else None


def upsert_portrait_asset(asset):
    now = now_ms()
    defaults = {
        'group_id': asset['groupId'], 'byteplus_asset_id': asset.get('byteplusAssetId'), 'name': asset.get('name'),
        'asset_type': asset.get('assetType') or 'Image', 'role': asset.get('role') or 'reference',
        'image_url': asset['imageUrl'], 'status': asset.get('status') or 'Processing',
        'status_message': asset.get('statusMessage'), 'created_at': asset.get('createdAt') or now,
        'updated_at': asset.get('updatedAt') or now}
    if asset.get('createdById'):
        defaults['created_by_id'] = asset['createdById']
    row, _ = PortraitAsset.objects.update_or_create(pk=asset['id'], defaults=defaults)
    return asset_json(row)


def update_portrait_asset_status(identifier, status, message=None):
    PortraitAsset.objects.filter(byteplus_asset_id=identifier).update(status=status, status_message=message, updated_at=now_ms())
    return get_portrait_asset_by_byteplus_id(identifier)


def update_portrait_asset_name(identifier, name):
    PortraitAsset.objects.filter(pk=identifier).update(name=name.strip(), updated_at=now_ms())
    return get_portrait_asset(identifier)


def delete_portrait_asset(identifier):
    asset = get_portrait_asset(identifier) or get_portrait_asset_by_byteplus_id(identifier)
    if asset:
        PortraitAsset.objects.filter(pk=asset['id']).delete()
    return asset


def delete_portrait_group(identifier):
    group = get_portrait_group(identifier)
    if group:
        PortraitGroup.objects.filter(pk=identifier).delete()
    return group


@transaction.atomic
def ensure_default_portrait_group(project_id=None):
    acquire_scope_locks('portrait-default:' + str(project_id or 'global'))
    rows = list(PortraitGroup.objects.filter(project_id=project_id))
    if rows:
        general = lambda row: bool(re.search(r'general|default', row.name, re.I))
        selected = next((row for row in rows if row.byteplus_group_id and general(row)), None) or next((row for row in rows if row.byteplus_group_id), None) or next((row for row in rows if general(row)), None) or rows[0]
        return group_json(selected)
    return upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'General Portraits',
        'description': 'Default portrait collection', 'projectId': project_id})
