"""Complete remote discovery before reconciliation; durable identity checkpoints."""
import re
import uuid
from datetime import datetime
from urllib.parse import urlsplit
from django.conf import settings
from django.db import connection
from apps.library.services.idempotency import now_ms
from apps.media.keys import media_key_from_ref
from apps.media.storage import get_storage
from . import portrait_db as db
from .byteplus import get_client, Deadline


def list_all_pages(list_page, *, max_pages=1000, signal=None, **input):
    items, tokens, token = {}, set(), None
    for page in range(max_pages):
        if signal: signal.check()
        response = list_page(**input, max_results=100, next_token=token, signal=signal)
        if not isinstance(response, dict) or not isinstance(response.get('Items'), list):
            raise ValueError('Invalid BytePlus inventory page.')
        for item in response['Items']:
            if not isinstance(item, dict) or not item.get('Id'):
                raise ValueError('BytePlus inventory item has no ID.')
            items[item['Id']] = item
        token = response.get('NextToken')
        if not token:
            return {'items': sorted(items.values(), key=lambda item: item['Id']), 'pages': page + 1}
        if token in tokens:
            raise ValueError('Repeated BytePlus pagination token.')
        tokens.add(token)
    raise ValueError('BytePlus inventory exceeded page limit.')


def unlinked_global_candidate(groups, remote, remote_groups):
    normalize = lambda name: (name or '').strip().lower()
    name = normalize(remote.get('Name'))
    if not name or sum(normalize(group.get('Name')) == name for group in remote_groups) != 1:
        return None
    candidates = [group for group in groups if not group.get('projectId') and not group.get('byteplusGroupId') and normalize(group['name']) == name]
    return candidates[0] if len(candidates) == 1 else None


def durable_ref(ref):
    if not isinstance(ref, str):
        return False
    if ref.startswith('/api/media/'):
        return True
    cdn = getattr(settings, 'GCP_MEDIA_CDN_URL', '').rstrip('/')
    if cdn and ref.startswith(cdn + '/'):
        return True
    try:
        url = urlsplit(ref)
        bucket = getattr(settings, 'GCP_MEDIA_BUCKET', '') or getattr(settings, 'GCS_BUCKET_NAME', '')
        if bucket and (url.hostname == bucket + '.storage.googleapis.com' or (url.hostname == 'storage.googleapis.com' and url.path.startswith('/' + bucket + '/'))):
            return True
        bucket = getattr(settings, 'AWS_S3_BUCKET_NAME', '')
        if bucket and (re.fullmatch(re.escape(bucket) + r'\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com', url.hostname or '') or ((url.hostname or '').startswith('s3.') and url.path.startswith('/' + bucket + '/'))):
            return True
    except ValueError:
        pass
    return False


def portrait_display_ref(local_ref, remote_ref):
    return local_ref if durable_ref(local_ref) else remote_ref or local_ref


def sign_stored_ref(ref, *, actor_id=None):
    key = media_key_from_ref(ref, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
    return get_storage().signed_read_url(key, 3600, actor_id=actor_id) if key else ref


def local_result(project_id=None):
    return {'groups': db.list_portrait_groups(project_id), 'assets': db.list_all_portrait_assets(project_id), 'syncedWithByteplus': False}


def inventory_portraits(client=None):
    if settings.LOCAL_DATA_MODE == 'read_only_viewer':
        return local_result()
    client = client or get_client()
    groups, assets = db.list_portrait_groups(), db.list_all_portrait_assets()
    local = {'groups': [{key: group.get(key) for key in ('id', 'projectId', 'byteplusGroupId')} for group in groups],
        'assets': [{key: asset.get(key) for key in ('id', 'groupId', 'byteplusAssetId')} for asset in assets]}
    if client.is_mock or not client.available:
        return {'local': local, 'remote': None, 'inventoryError': 'Live BytePlus asset credentials unavailable.'}
    signal = Deadline()
    remote_groups = list_all_pages(client.list_asset_groups, signal=signal, group_type='AIGC', project_name='default')
    remote_assets = list_all_pages(client.list_assets, signal=signal, group_type='AIGC', project_name='default')
    local_ids = {asset['byteplusAssetId'] for asset in assets if asset.get('byteplusAssetId')}
    remote_ids = {asset['Id'] for asset in remote_assets['items']}
    return {'local': local, 'remote': {
        'groups': [{'id': group['Id']} for group in remote_groups['items']],
        'assets': [{'id': asset['Id'], 'groupId': asset.get('GroupId')} for asset in remote_assets['items']],
        'groupPages': remote_groups['pages'], 'assetPages': remote_assets['pages']},
        'remoteAssetsMissingLocally': sorted(remote_ids - local_ids), 'localAssetsMissingRemotely': sorted(local_ids - remote_ids)}


def remote_time(value):
    return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000) if value else now_ms()


def sync_portraits(project_id=None, client=None):
    if settings.LOCAL_DATA_MODE == 'read_only_viewer':
        return local_result(project_id)
    client = client or get_client()
    if client.is_mock or not client.available:
        return local_result(project_id)
    # A session-level try-lock permits each successful identity write to commit
    # before later network calls; waiting requests never occupy pool slots.
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_try_advisory_lock(746833219)')
        locked = cursor.fetchone()[0]
    if not locked:
        return {**local_result(project_id), 'syncInProgress': True}
    try:
        return reconcile(project_id, client)
    except Exception:
        return {**local_result(project_id), 'syncError': 'Portrait synchronization incomplete; local records preserved.'}
    finally:
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_unlock(746833219)')


def reconcile(project_id, client):
    signal = Deadline()
    inputs = {'group_type': 'AIGC', 'project_name': 'default', 'signal': signal}
    group_inventory = list_all_pages(client.list_asset_groups, **inputs)
    asset_inventory = list_all_pages(client.list_assets, **inputs)
    remote_groups, remote_assets = group_inventory['items'], asset_inventory['items']
    groups_by_bp, push_errors = {}, []
    for remote in remote_groups:
        local = db.get_portrait_group_by_byteplus_id(remote['Id'])
        created, updated = remote_time(remote.get('CreateTime')), remote_time(remote.get('UpdateTime'))
        if not local:
            unlinked = unlinked_global_candidate(db.list_portrait_groups(), remote, remote_groups)
            local = db.upsert_portrait_group({**unlinked, 'byteplusGroupId': remote['Id'], 'updatedAt': updated}) if unlinked else db.upsert_portrait_group({
                'id': str(uuid.uuid4()), 'byteplusGroupId': remote['Id'], 'name': remote.get('Name') or 'Untitled Group',
                'description': remote.get('Description') or '', 'groupType': remote.get('GroupType') or 'AIGC',
                'projectName': remote.get('ProjectName') or 'default', 'createdAt': created, 'updatedAt': updated})
        elif local['name'] != remote.get('Name'):
            local = db.upsert_portrait_group({**local, 'name': remote.get('Name') or local['name'], 'updatedAt': updated})
        groups_by_bp[remote['Id']] = local
    for remote in remote_assets:
        local_group = groups_by_bp.get(remote.get('GroupId')) or db.get_portrait_group_by_byteplus_id(remote.get('GroupId'))
        if not local_group:
            local_group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'byteplusGroupId': remote.get('GroupId'),
                'name': remote.get('Name') or 'Portrait Group', 'description': '', 'groupType': 'AIGC', 'projectName': 'default'})
            groups_by_bp[remote.get('GroupId')] = local_group
        local_asset = db.get_portrait_asset_by_byteplus_id(remote['Id'])
        created, updated = remote_time(remote.get('CreateTime')), remote_time(remote.get('UpdateTime'))
        if not local_asset:
            db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': local_group['id'], 'byteplusAssetId': remote['Id'],
                'name': remote.get('Name') or local_group['name'] or 'Portrait', 'assetType': remote.get('AssetType') or 'Image',
                'role': 'reference', 'imageUrl': remote.get('URL'), 'status': remote.get('Status') or 'Active', 'createdAt': created, 'updatedAt': updated})
        else:
            image_url = portrait_display_ref(local_asset['imageUrl'], remote.get('URL'))
            if local_asset['status'] != remote.get('Status') or image_url != local_asset['imageUrl']:
                db.upsert_portrait_asset({**local_asset, 'imageUrl': image_url, 'status': remote.get('Status') or local_asset['status'], 'updatedAt': updated})
    groups, assets = db.list_portrait_groups(), db.list_all_portrait_assets()
    fresh_urls = {asset['Id']: asset['URL'] for asset in remote_assets if asset.get('URL')}
    for asset in assets:
        if asset.get('byteplusAssetId') or not asset.get('imageUrl'):
            continue
        if asset.get('statusMessage') == 'registration_outcome_unknown' or any(a['groupId'] == asset['groupId'] and a.get('statusMessage') == 'group_registration_outcome_unknown' for a in assets):
            push_errors.append({'id': asset['id'], 'code': 'registration_outcome_unknown'})
            continue
        try:
            parent = next((g for g in groups if g['id'] == asset['groupId']), None)
            if not parent:
                raise ValueError('Portrait parent group missing.')
            if not parent.get('byteplusGroupId'):
                asset['statusMessage'] = 'group_registration_outcome_unknown'
                db.upsert_portrait_asset(asset)
                result = client.create_asset_group(parent['name'] or 'General Portraits', parent.get('description') or 'Virtual Portrait Group', signal=signal)
                if not result.get('Id'):
                    raise ValueError('BytePlus did not return a group identity.')
                updated = db.upsert_portrait_group({**parent, 'byteplusGroupId': result['Id'], 'updatedAt': now_ms()})
                parent.update(updated)
                asset['statusMessage'] = None
                db.upsert_portrait_asset(asset)
            signed_url = sign_stored_ref(asset['imageUrl'])
            if signed_url and not signed_url.startswith('data:'):
                asset['statusMessage'] = 'registration_outcome_unknown'
                db.upsert_portrait_asset(asset)
                result = client.create_asset(parent['byteplusGroupId'], signed_url, name=asset.get('name') or 'Portrait', signal=signal)
                if not result.get('Id'):
                    raise ValueError('BytePlus did not return an asset identity.')
                asset.update(byteplusAssetId=result['Id'], status=result.get('Status') or 'Active', statusMessage=None, updatedAt=now_ms())
                db.upsert_portrait_asset(asset)
                if result.get('URL'):
                    fresh_urls[result['Id']] = result['URL']
        except Exception as exc:
            push_errors.append({'id': asset['id'], 'code': getattr(exc, 'code', 'registration_failed')})
    final_groups, final_assets = db.list_portrait_groups(project_id), db.list_all_portrait_assets(project_id)
    for asset in final_assets:
        fresh = fresh_urls.get(asset.get('byteplusAssetId'))
        if fresh:
            asset['imageUrl'] = portrait_display_ref(asset['imageUrl'], fresh)
    by_id = {asset['id']: asset for asset in final_assets}
    for group in final_groups:
        group['assets'] = [by_id.get(asset['id'], asset) for asset in group['assets']]
    result = {'groups': final_groups, 'assets': final_assets, 'syncedWithByteplus': not push_errors,
        'inventory': {'groupPages': group_inventory['pages'], 'assetPages': asset_inventory['pages'], 'remoteGroups': len(remote_groups), 'remoteAssets': len(remote_assets)}}
    if push_errors:
        result.update(syncError='Some portraits could not be registered; local records preserved.', registrationErrors=push_errors)
    return result
