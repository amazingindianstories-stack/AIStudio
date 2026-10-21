"""Eight portrait HTTP method contracts, backed by durable local identities."""
import base64
import json
import uuid
from django.db import transaction
from django.conf import settings
from apps.media.uploads import resolve_owned_ready_upload as resolve_ready_upload, UploadError
from .models import PortraitAsset, PortraitGroup
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.responses import log_activity, renew_session
from apps.generation.watermark import WHITESPACE
from apps.library.services.idempotency import now_ms
from apps.library.views import body_or_empty
from apps.media.images import save_asset_image, delete_asset_image, split_data_url
from apps.integrations.byteplus import get_client, BytePlusAssetError, validate_portrait_image
from . import portrait_db as db
from . import portrait_lifecycle, portrait_registration, portrait_remote_delete
from .portrait_sync import sync_portraits, inventory_portraits, sign_stored_ref


def text(value):
    return (value or '').strip(WHITESPACE)


def error_response(error, fallback, byteplus_status=False):
    return Response({'error': fallback}, status=error.status if byteplus_status and isinstance(error, BytePlusAssetError) else 500)


def quiet(call, *args):
    try:
        return call(*args)
    except Exception:
        return None


def cleanup_deleted_portraits(client, assets, group=None):
    """Retain original objects: other catalog/history/Canvas references can outlive portraits.

    Physical object cleanup requires a complete durable-reference inventory and
    concurrency fence; a portrait row alone cannot prove an original is orphaned.
    Remote identities are removed only after the catalog transaction returned.
    Under the portrait lifecycle nothing is removed: deleted portraits are tombstones.
    """
    if portrait_lifecycle.enabled():
        return None
    try:
        for asset in assets:
            identity = asset.get('byteplusAssetId')
            if identity and not PortraitAsset.objects.filter(byteplus_asset_id=identity).exists():
                quiet(client.delete_asset, identity)
        identity = (group or {}).get('byteplusGroupId')
        if identity and not PortraitGroup.objects.filter(byteplus_group_id=identity).exists():
            quiet(client.delete_asset_group, identity)
    except Exception:
        pass  # Unavailable reference queries cannot authorize irreversible cleanup.


def remove_portrait_asset(asset):
    if portrait_lifecycle.enabled():
        return db.archive_portrait_asset(asset)
    with transaction.atomic():
        PortraitGroup.objects.select_for_update().filter(pk=asset['groupId']).first()
        group = db.get_portrait_group(asset['groupId'])
        db.delete_portrait_asset(asset['id'])
        if group and group.get('primaryAssetId') == asset['imageUrl']:
            remaining = db.list_portrait_assets(group['id'])
            db.upsert_portrait_group({**group, 'primaryAssetId': remaining[0]['imageUrl'] if remaining else None,
                'updatedAt': now_ms()})


def first(request, key):
    values = request.query_params.getlist(key)
    return values[0] if values else None


def remote_delete(request, path_group=None):
    """The portrait lifecycle's DELETE for both routes: BytePlus first, then a local tombstone."""
    actor = lookup(request)
    if actor is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    asset_id = first(request, 'assetId')
    if not asset_id:
        return Response({'error': 'assetId is required; character-group deletion remains unavailable.'}, status=400)
    store = portrait_remote_delete.DjangoDeleteStore()
    asset = store.get(asset_id)
    if not asset:
        return Response({'ok': False, 'error': 'Portrait no longer exists; refresh Gallery before retrying.'}, status=404)
    requested_group = path_group or first(request, 'groupId')
    if not requested_group:
        return Response({'ok': False, 'error': 'Character identity is required.'}, status=400)
    try:
        result = portrait_remote_delete.delete_once(asset, actor.id, project_id=first(request, 'projectId'), group_id=requested_group, store=store,
                                                    client=portrait_remote_delete.native_delete_client())
        log_activity(actor.id, 'delete_portrait_asset', {'id': asset['id'], 'groupId': asset['groupId'], 'remoteDeletion': result['remoteDeletion']})
        return renew_session(request, Response(result))
    except portrait_remote_delete.DeleteHold as exc:
        return Response({'ok': False, 'error': str(exc)}, status=409)
    except Exception:
        return Response({'ok': False, 'error': 'BytePlus deletion could not be verified. Portrait retained; no automatic retry.'}, status=502)


@api_view(['GET', 'POST', 'PATCH', 'DELETE'])
@authentication_classes([])
@permission_classes([])
def portraits(request):
    if request.method == 'DELETE' and portrait_lifecycle.enabled():
        return remote_delete(request)
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    body = body_or_empty(request) if request.method in ('POST', 'PATCH') else {}
    try:
        if request.method == 'GET':
            if first(request, 'inventory') == '1':
                if user.role != 'admin':
                    return Response({'error': 'FORBIDDEN'}, status=403)
                return renew_session(request, Response(inventory_portraits()))
            return renew_session(request, Response(sync_portraits(first(request, 'projectId') or None)))
        if request.method == 'POST':
            name, description = text(body.get('name')), text(body.get('description'))
            if not name:
                return Response({'error': 'Character name is required.'}, status=400)
            # Under the portrait lifecycle a new character stays local until an upload registers it.
            result = {} if portrait_lifecycle.enabled() else get_client().create_asset_group(name, description, group_type='AIGC')
            group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'byteplusGroupId': result.get('Id'),
                'name': name, 'description': description, 'groupType': 'AIGC', 'projectName': 'default',
                'projectId': body.get('projectId') or None})
            detail = {'id': group['id'], 'byteplusGroupId': result.get('Id'), 'name': name}
            if body.get('projectId'): detail['projectId'] = body['projectId']
            log_activity(user.id, 'create_portrait_group', detail)
            return renew_session(request, Response(group))
        if request.method == 'PATCH':
            asset_id, group_id, name = body.get('assetId'), body.get('groupId'), text(body.get('name'))
            if (not asset_id and not group_id) or not name:
                return Response({'error': 'assetId or groupId, and name are required.'}, status=400)
            if group_id:
                group = db.get_portrait_group(group_id)
                if not group:
                    return Response({'error': 'Character group not found.'}, status=404)
                updated = db.upsert_portrait_group({**group, 'name': name, 'updatedAt': now_ms()})
                log_activity(user.id, 'rename_portrait_group', {'id': group_id, 'name': name})
                return renew_session(request, Response({'ok': True, 'group': updated}))
            updated = db.update_portrait_asset_name(asset_id, name)
            if not updated:
                return Response({'error': 'Asset not found.'}, status=404)
            log_activity(user.id, 'rename_portrait_asset', {'id': asset_id, 'name': name})
            return renew_session(request, Response({'ok': True, 'asset': updated}))
        asset_id, group_id = first(request, 'assetId'), first(request, 'id')
        if not asset_id and not group_id:
            return Response({'error': 'Missing assetId or id parameter.'}, status=400)
        client = get_client()
        if asset_id:
            asset = db.get_portrait_asset(asset_id) or db.get_portrait_asset_by_byteplus_id(asset_id)
            if not asset:
                # A caller-supplied prefix is not durable proof of an orphan.
                # Repeated deletion is local/idempotent; unknown remote objects
                # require an independently verified reconciliation inventory.
                return Response({'ok': True, 'deleted': 'already_removed'})
            bp_id = asset.get('byteplusAssetId') or (asset_id if asset_id.startswith('asset-') else None)
            remove_portrait_asset(asset)
            cleanup_deleted_portraits(client, [{**asset, 'byteplusAssetId': bp_id}])
            log_activity(user.id, 'delete_portrait_asset', {'id': asset['id'], 'name': asset.get('name')})
            return renew_session(request, Response({'ok': True}))
        group = db.get_portrait_group(group_id)
        if not group:
            return Response({'error': 'Character group not found.'}, status=404)
        with transaction.atomic():
            PortraitGroup.objects.select_for_update().filter(pk=group_id).first()
            db.delete_portrait_group(group_id)
        cleanup_deleted_portraits(client, group.get('assets', []), group)
        log_activity(user.id, 'delete_portrait_group', {'id': group_id, 'byteplusGroupId': group.get('byteplusGroupId'), 'name': group['name']})
        return renew_session(request, Response({'ok': True}))
    except Exception as exc:
        return renew_session(request, error_response(exc, 'Failed to process portrait resource.', byteplus_status=request.method == 'POST'))


def valid_data_url(data_url):
    return isinstance(data_url, str) and data_url.startswith('data:')


def decode_validate(data_url):
    _, encoded = split_data_url(data_url)
    return validate_portrait_image(base64.b64decode(encoded, validate=True))


@api_view(['GET', 'POST', 'DELETE'])
@authentication_classes([])
@permission_classes([])
def group_assets(request, id):
    if request.method == 'DELETE' and portrait_lifecycle.enabled():
        return remote_delete(request, id)
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    if not id:
        return Response({'error': 'Missing group id.'}, status=400)
    try:
        local_only = request.method == 'POST' and portrait_lifecycle.enabled()
        client = None if local_only or settings.LOCAL_DATA_MODE == 'read_only_viewer' else get_client()
        if request.method == 'DELETE':
            asset_id = first(request, 'assetId')
            if not asset_id:
                return Response({'error': 'Missing group id or asset id.'}, status=400)
            asset = db.get_portrait_asset(asset_id)
            if not asset or asset['groupId'] != id:
                return Response({'error': 'Asset not found in group.'}, status=404)
            remove_portrait_asset(asset)
            cleanup_deleted_portraits(client, [asset])
            log_activity(user.id, 'delete_portrait_asset', {'assetId': asset_id, 'groupId': id, 'byteplusAssetId': asset.get('byteplusAssetId')})
            return renew_session(request, Response({'ok': True}))
        group = db.get_portrait_group(id)
        if not group:
            return Response({'error': 'Character group not found.'}, status=404)
        if request.method == 'GET':
            assets = db.list_portrait_assets(id)
            for asset in assets:
                if client and asset['status'] == 'Processing' and asset.get('byteplusAssetId'):
                    try:
                        remote = client.get_asset(asset['byteplusAssetId'])
                        if remote.get('Status') and remote['Status'] != asset['status']:
                            db.update_portrait_asset_status(asset['byteplusAssetId'], remote['Status'], remote.get('StatusMessage') or remote.get('ErrorMessage'))
                    except Exception:
                        pass
            return renew_session(request, Response({'assets': db.list_portrait_assets(id)}))
        body = body_or_empty(request)
        data_url, name, role = body.get('dataUrl'), text(body.get('name')) or 'Portrait Reference', body.get('role') or 'reference'
        if body.get('referenceId'):
            ready = resolve_ready_upload(user.id, body['referenceId'], purposes={'portrait'})
            saved = '/api/media/' + ready.key
            image_info = None
        else:
            if not valid_data_url(data_url):
                return Response({'error': 'Verified referenceId or valid image data URL is required.'}, status=400)
            image_info = decode_validate(data_url)
            saved = save_asset_image(data_url)
        if local_only:
            remote = {'Status': 'LocalOnly'}
        else:
            signed = sign_stored_ref(saved, actor_id=user.id) or saved
            if not group.get('byteplusGroupId'):
                try:
                    result = client.create_asset_group(group['name'] or 'Default Character', group.get('description') or 'Virtual Portrait Group')
                    if result.get('Id'):
                        group = db.upsert_portrait_group({**group, 'byteplusGroupId': result['Id'], 'updatedAt': now_ms()})
                except Exception:
                    pass
            remote = client.create_asset(group.get('byteplusGroupId'), signed, name=name, asset_type='Image')
        record = {'id': str(uuid.uuid4()), 'groupId': id, 'byteplusAssetId': remote.get('Id'),
            'createdById': str(user.id), 'name': name, 'assetType': 'Image', 'role': role, 'imageUrl': saved, 'status': remote.get('Status') or 'Processing'}
        if local_only:
            record['statusMessage'] = 'remote_registration_not_authorized'
        asset = db.upsert_portrait_asset(record)
        if not group.get('primaryAssetId'):
            db.upsert_portrait_group({**group, 'primaryAssetId': saved, 'updatedAt': now_ms()})
        log_activity(user.id, 'upload_portrait_asset', {'assetId': asset['id'], 'groupId': id, 'byteplusAssetId': remote.get('Id'),
            'name': name, 'format': image_info['format'] if image_info else 'verified-upload', 'resolution': f'{image_info["width"]}x{image_info["height"]}' if image_info else None})
        return renew_session(request, Response(asset))
    except UploadError as exc:
        return Response({'error': str(exc)}, status=exc.status)
    except Exception as exc:
        return renew_session(request, error_response(exc, 'Failed to process portrait asset.', byteplus_status=request.method == 'POST'))


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def upload(request):
    if portrait_lifecycle.enabled():
        return registered_upload(request)
    return _upload(request)


def registered_upload(request):
    """The portrait lifecycle's upload: saved locally, then a verified native upload registers once."""
    actor = lookup(request)
    if actor is None:
        return _upload(request)
    body = body_or_empty(request)
    store = portrait_registration.DjangoStore()
    if body.get('groupId'):
        group = store.group(body['groupId'])
        if not group or (group.get('projectId') and str(group['projectId']) != str(body.get('projectId'))):
            return Response({'error': 'Portrait group is outside the requested project scope.'}, status=403)
    # Native resumable READY identity is reused after an uncertain HTTP response.
    if body.get('referenceId'):
        ready = resolve_ready_upload(actor.id, body['referenceId'], purposes={'portrait'})
        ref = '/api/media/' + ready.key
        query = store.Asset.objects.filter(created_by_id=actor.id, image_url=ref).exclude(status='PreviewDeleted')
        if body.get('groupId'):
            query = query.filter(group_id=body['groupId'])
        prior = list(query[:2])
        if len(prior) == 1:
            return renew_session(request, Response({'ok': True, 'asset': store.db.asset_json(prior[0]), 'registrationReused': True}))
        if len(prior) > 1:
            return Response({'error': 'Ambiguous existing portrait identity; reconcile without registration retry.'}, status=409)
    response = _upload(request)
    if response.status_code >= 400 or not isinstance(response.data, dict) or not response.data.get('asset'):
        return response
    asset = response.data['asset']
    if not body.get('referenceId'):
        response.data['registrationError'] = 'Use a verified native upload to register this local image.'
        return response
    from apps.media.storage import get_storage
    from apps.integrations.byteplus import validate_portrait_image, MAX_FILE_BYTES
    try:
        asset = portrait_registration.register_once(asset, actor.id, store=store,
                                                    read_native=lambda ref: get_storage().read_reference_bytes(ref, max_bytes=MAX_FILE_BYTES)['bytes'],
                                                    sign_native=sign_stored_ref, client=portrait_registration.native_client(), validate=validate_portrait_image)
        asset = {**asset, 'remoteVerification': portrait_registration.remote_verification(asset)}
        response.data['asset'] = asset
        if asset['status'] in ('RegistrationFailed', 'RegistrationUnknown', 'RegistrationGroupUnknown', 'LocalOnly'):
            message = asset.get('statusMessage') or 'Registration unavailable'
            try:
                message = json.loads(message).get('error_code') or message
            except (TypeError, ValueError):
                pass
            response.data['registrationError'] = message
    except Exception as exc:
        code = portrait_registration.safe_registration_error(exc)
        # Only an unclaimed LocalOnly row is changed; pending/unknown provenance stays.
        current = store.local_error(asset['id'], code)
        response.data['asset'] = {**current, 'remoteVerification': 'local_only' if current.get('status') == 'LocalOnly' else 'unverified'}
        response.data['registrationErrorCode'] = code
        response.data['registrationError'] = portrait_registration.registration_error_message(code)
    return response


def _upload(request):
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    body = body_or_empty(request)
    data_url = body.get('dataUrl')
    if not body.get('referenceId') and not valid_data_url(data_url):
        return Response({'error': 'Verified referenceId or valid image data URL is required.'}, status=400)
    try:
        name, role = text(body.get('name')) or 'Portrait', body.get('role') or 'reference'
        group = db.get_portrait_group(body['groupId']) if body.get('groupId') else None
        group = group or db.ensure_default_portrait_group(body.get('projectId') or None)
        if body.get('referenceId'):
            ready = resolve_ready_upload(user.id, body['referenceId'], purposes={'portrait'})
            saved = '/api/media/' + ready.key
        else:
            decode_validate(data_url)
            saved = save_asset_image(data_url)
        if portrait_lifecycle.enabled():
            # Saved locally only; native registration decides about BytePlus afterwards.
            bp_id, initial_status, message = None, 'LocalOnly', 'remote_registration_not_authorized'
        else:
            client = get_client()
            bp_id, initial_status, message = None, 'Active', None
            try:
                if not group.get('byteplusGroupId'):
                    remote = client.create_asset_group(group['name'] or 'General Portraits', group.get('description') or 'Virtual Portrait Group')
                    if remote.get('Id'):
                        group = db.upsert_portrait_group({**group, 'byteplusGroupId': remote['Id'], 'updatedAt': now_ms()})
                if group.get('byteplusGroupId'):
                    remote = client.create_asset(group['byteplusGroupId'], sign_stored_ref(saved, actor_id=user.id) or saved, name=name, asset_type='Image')
                    bp_id, initial_status = remote.get('Id'), remote.get('Status') or initial_status
            except (UploadError, ValueError):
                raise
            except Exception:
                if not client.is_mock:
                    raise
        asset = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'byteplusAssetId': bp_id,
            'createdById': str(user.id), 'name': name, 'assetType': 'Image', 'role': role, 'imageUrl': saved, 'status': initial_status, 'statusMessage': message})
        log_activity(user.id, 'upload_portrait_asset', {'id': asset['id'], 'name': name, 'imageUrl': saved})
        return renew_session(request, Response({'ok': True, 'asset': asset}))
    except UploadError as exc:
        return Response({'error': str(exc)}, status=exc.status)
    except Exception as exc:
        return renew_session(request, error_response(exc, 'Failed to upload portrait.', byteplus_status=True))
