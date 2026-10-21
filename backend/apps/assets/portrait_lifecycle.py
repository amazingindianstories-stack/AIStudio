"""Old manual portrait routes under VEEVEE_PORTRAIT_LIFECYCLE: list-only sync and tombstones.

This is the rollback path for the automatic pool, so it is off whenever
VEEVEE_MANAGED_PORTRAITS is on, and only the API process uses it. Reconcile
imports missing remote identities only (existing rows are immutable evidence)
and projects remote verification onto response copies; no remote writes happen
while listing. Deleted portraits stay as PreviewDeleted tombstones that every
listing hides, and uploads stay local unless registration takes them.
"""
import json
from urllib.parse import urlsplit, parse_qs
from django.conf import settings

TOMBSTONE = 'PreviewDeleted'


def enabled():
    return bool(getattr(settings, 'VEEVEE_PORTRAIT_LIFECYCLE', False)
                and getattr(settings, 'VEEVEE_RUNTIME_COMPONENT', None) == 'api'
                and not getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False))


def need(value):
    if not value:
        raise ValueError('Preview portrait pull-only HOLD')


class ListOnlyClient:
    def __init__(self, client):
        self._client = client

    @property
    def is_mock(self):
        return self._client.is_mock

    @property
    def available(self):
        return self._client.available

    def list_asset_groups(self, **kw):
        return self._client.list_asset_groups(**kw)

    def list_assets(self, **kw):
        return self._client.list_assets(**kw)

    def __getattr__(self, name):
        raise ValueError('Remote portrait write/interface forbidden')


def local_operation(asset):
    try:
        marker = json.loads(asset.get('statusMessage') or '{}')
        if not isinstance(marker, dict):
            marker = {}
    except (ValueError, TypeError):
        marker = {}
    status = asset.get('status') or ''
    if marker.get('operation') == 'REMOTE_DELETE':
        return {'CLAIMED_ACK_UNCERTAIN': 'deletion_pending', 'DELETE_UNKNOWN': 'deletion_unknown', 'DELETE_FAILED': 'deletion_failed'}.get(marker.get('state'))
    if status.startswith('RemoteDeletion'):
        return {'RemoteDeletionPending': 'deletion_pending', 'RemoteDeletionUnknown': 'deletion_unknown', 'RemoteDeletionFailed': 'deletion_failed'}.get(status, 'deletion_unknown')
    if status.startswith('Registration'):
        return 'registration_unknown' if 'Unknown' in status else 'registration_failed' if 'Failed' in status else 'registration_pending'
    if marker.get('state') in ('CLAIMED_ACK_UNCERTAIN', 'GROUP_CLAIMED_ACK_UNCERTAIN'):
        return 'registration_unknown' if marker.get('error_code') else 'registration_pending'
    if asset.get('statusMessage') in ('registration_outcome_unknown', 'group_registration_outcome_unknown'):
        return 'registration_unknown'
    return None


def group_operation_hold(asset):
    if (asset.get('status') or '').startswith(('Registration', 'RemoteDeletion')):
        return True
    if asset.get('statusMessage') in ('registration_outcome_unknown', 'group_registration_outcome_unknown'):
        return True
    try:
        marker = json.loads(asset.get('statusMessage') or '{}')
    except (ValueError, TypeError):
        return False
    if not isinstance(marker, dict):
        return False
    return marker.get('state') in ('CLAIMED_ACK_UNCERTAIN', 'GROUP_CLAIMED_ACK_UNCERTAIN', 'DELETE_UNKNOWN', 'DELETE_FAILED')


def project_readiness(result, remote_assets=None, verified_at=None, remote_groups=None):
    # Response copies only: originals, recorded status and tombstones are untouched.
    complete = remote_assets is not None
    remote = {a['Id']: a for a in remote_assets} if complete else {}

    def asset(a):
        out = dict(a)
        if out.get('status') == 'PreviewDeleted':
            return out
        identifier = out.get('byteplusAssetId')
        operation = local_operation(a)
        if operation:
            out['localOperation'] = operation
        state = 'local_only' if not identifier else 'unverified'
        if identifier and complete:
            found = remote.get(identifier)
            state = ({'Active': 'active', 'Processing': 'processing', 'Failed': 'failed'}.get(found.get('Status'), 'unverified') if found else 'absent')
            if found:
                out['remoteStatus'] = found.get('Status')
            if state in ('active', 'processing', 'failed') and not operation:
                out['status'] = found['Status']
            elif state == 'absent':
                if not operation:
                    out['status'] = 'RemoteMissing'
                out['remoteVerificationMessage'] = 'This historical asset ID is absent from the verified BytePlus default catalogue. Original local record and media are preserved.'
        if identifier and state == 'unverified':
            if not operation:
                out['status'] = 'RemoteUnverified'
            out['remoteVerificationMessage'] = 'BytePlus registration could not be verified; local record and media are preserved.'
        out['remoteVerification'] = state
        if complete:
            out['remoteVerifiedAt'] = verified_at
        out['catalogueScope'] = {'projectName': 'default', 'groupType': 'AIGC', 'region': 'ap-southeast-1'}
        return out
    out = dict(result)
    assets = [asset(a) for a in result.get('assets', [])]
    byid = {a['id']: a for a in assets}
    if 'assets' in result:
        out['assets'] = assets
    if 'groups' in result:
        present_groups = {g['Id'] for g in remote_groups} if remote_groups is not None else None
        projected = []
        for group in result['groups']:
            identifier = group.get('byteplusGroupId')
            eligible = group.get('projectName', 'default') == 'default' and group.get('groupType', 'AIGC') == 'AIGC'
            state = 'local_only' if not identifier else 'unverified' if present_groups is None or not eligible else 'present' if identifier in present_groups else 'absent'
            item = {**group, 'assets': [byid.get(a['id'], asset(a)) for a in group.get('assets', [])], 'groupVerification': state, 'remoteGroupMissing': state == 'absent'}
            if present_groups is not None and eligible:
                item['groupVerifiedAt'] = verified_at
            item['groupOperationHold'] = any(group_operation_hold(a) for a in group.get('assets', []))
            item['groupCatalogueScope'] = {'projectName': 'default', 'groupType': 'AIGC', 'region': 'ap-southeast-1'}
            projected.append(item)
        out['groups'] = projected
    return out


def list_transport():
    from apps.generation.providers import transport

    class PortraitListTransport(transport.HttpTransport):
        paid_guard_exempt = True  # asset-library listing only; exact allowlist below

        def request(self, method, url, *, headers=None, body=None, raw_body=None, signal=None):
            parsed = urlsplit(url)
            query = parse_qs(parsed.query, keep_blank_values=True)
            need(method == 'POST' and parsed.scheme == 'https' and parsed.netloc == 'ark.ap-southeast-1.byteplusapi.com' and parsed.path == '/' and not parsed.fragment)
            need(set(query) == {'Action', 'Version'} and query['Action'] in (['ListAssetGroups'], ['ListAssets']) and query['Version'] == ['2024-01-01'])
            need(body is None and isinstance(raw_body, bytes) and len(raw_body) <= 32768)
            payload = json.loads(raw_body)
            need(isinstance(payload, dict) and set(payload) <= {'ProjectName', 'Filter', 'MaxResults', 'NextToken'})
            need(payload.get('ProjectName') == 'default' and payload.get('Filter') == {'GroupType': 'AIGC'} and type(payload.get('MaxResults')) is int and 1 <= payload['MaxResults'] <= 100)
            need('NextToken' not in payload or isinstance(payload['NextToken'], str) and len(payload['NextToken']) <= 8192)
            return super().request(method, url, headers=headers, raw_body=raw_body, signal=signal)
    return PortraitListTransport(allowed_hosts={'ark.ap-southeast-1.byteplusapi.com'}, timeout=45)


def read_client():
    """A live BytePlus client that can only list the default AIGC catalogue."""
    from apps.assets import byteplus
    config = byteplus.config_from_env()
    config['is_mock'] = False
    return ListOnlyClient(byteplus.BytePlusClient(config=config, transport=list_transport()))


def visible_assets(assets):
    return [asset for asset in assets if asset.get('status') != TOMBSTONE]


def visible_groups(groups):
    result = []
    for group in groups:
        assets = visible_assets(group.get('assets', []))
        item = {**group, 'assets': assets, 'activeCount': sum(a.get('status') == 'Active' for a in assets),
                'processingCount': sum(a.get('status') == 'Processing' for a in assets)}
        if any(a.get('status') == TOMBSTONE and a.get('imageUrl') == item.get('primaryAssetId') for a in group.get('assets', [])):
            item['primaryAssetId'] = assets[0].get('imageUrl') if assets else None
        result.append(item)
    return result


def visible_result(result):
    result = dict(result)
    if 'assets' in result:
        result['assets'] = visible_assets(result['assets'])
    if 'groups' in result:
        result['groups'] = visible_groups(result['groups'])
    return result
