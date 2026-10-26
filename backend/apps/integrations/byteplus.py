"""BytePlus private portrait OpenAPI, exact signed bytes and injected transport."""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit
from django.conf import settings
from apps.integrations.transport import HttpTransport

FORMATS = ('jpeg', 'jpg', 'png', 'webp', 'bmp', 'tiff', 'gif', 'heic', 'heif')
MAX_FILE_BYTES = 30 * 1024 * 1024

class BytePlusAssetError(Exception):
    """``code`` is what callers branch on (``moderation_rejected`` for a compliance refusal); ``provider_error`` keeps
    BytePlus's exact answer (its own code, message and ResponseMetadata.RequestId) for receipts and the admin view."""
    def __init__(self, message, code='byteplus_asset_error', status=400, details=None, provider_error=None):
        super().__init__(message)
        self.code, self.status, self.details, self.provider_error = code, status, details, provider_error

class Deadline:
    def __init__(self, seconds=45):
        self.until = time.monotonic() + seconds
    def remaining(self):
        self.check()
        return self.until - time.monotonic()
    def check(self):
        if time.monotonic() >= self.until:
            raise TimeoutError('Portrait synchronization deadline exceeded.')


def config_from_env(env=None):
    env = os.environ if env is None else env
    region = env.get('BYTEPLUS_ARK_REGION') or 'ap-southeast-1'
    host = env.get('BYTEPLUS_ARK_HOST') or f'ark.{region}.byteplusapi.com'
    return {'ak': env.get('BYTEPLUS_ACCESS_KEY_ID') or env.get('VOLCENGINE_ACCESS_KEY_ID'),
        'sk': env.get('BYTEPLUS_SECRET_ACCESS_KEY') or env.get('VOLCENGINE_SECRET_ACCESS_KEY'),
        'region': region, 'host': host, 'base_url': env.get('BYTEPLUS_ARK_BASE_URL') or 'https://' + host,
        'is_mock': env.get('MOCK_ASSET_PROVIDER') == '1' or env.get('MOCK_GENERATION') == '1'}


def sign_request(*, body='', ak, sk, method='POST', pathname='/', query=None, headers=None,
                 region='ap-southeast-1', service='ark', date=None):
    date = date or datetime.now(timezone.utc)
    stamp, short = date.strftime('%Y%m%dT%H%M%SZ'), date.strftime('%Y%m%d')
    raw = body.encode() if isinstance(body, str) else body
    digest = hashlib.sha256(raw).hexdigest()
    request_headers = {**(headers or {}), 'x-date': stamp, 'x-content-sha256': digest}
    keys = sorted(key.lower() for key in request_headers)
    canonical_headers = ''.join(f'{key}:{str(request_headers.get(key, "")).strip()}\n' for key in keys)
    signed_headers = ';'.join(keys)
    query_string = '&'.join(quote(key, safe='~') + '=' + quote(str(value), safe='~') for key, value in sorted((query or {}).items()))
    canonical_request = '\n'.join([method.upper(), pathname if pathname.startswith('/') else '/' + pathname,
        query_string, canonical_headers, signed_headers, digest])
    scope = f'{short}/{region}/{service}/request'
    string_to_sign = '\n'.join(['HMAC-SHA256', stamp, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
    signing_key = sk.encode()
    for value in (short, region, service, 'request'):
        signing_key = hmac.new(signing_key, value.encode(), hashlib.sha256).digest()
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return {'headers': {**request_headers, 'Authorization': f'HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed_headers}, Signature={signature}'},
        'xDate': stamp, 'signedHeaders': signed_headers, 'signature': signature, 'stringToSign': string_to_sign}


def validate_portrait_image(data):
    if not data:
        raise BytePlusAssetError('Image buffer is empty.', 'invalid_image')
    if len(data) > MAX_FILE_BYTES:
        raise BytePlusAssetError(f'Image size ({len(data)/(1024*1024):.1f}MB) exceeds BytePlus 30MB limit.', 'file_too_large')
    from PIL import Image
    try:
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except ImportError:
            pass
        with Image.open(io.BytesIO(data)) as image:
            format_name = (image.format or '').lower()
            width, height = image.size
    except Exception as exc:
        raise BytePlusAssetError('Could not decode image: unsupported format.', 'decode_failed') from exc
    if format_name not in FORMATS:
        raise BytePlusAssetError(f"Image format '{format_name}' is not supported by BytePlus. Accepted: {', '.join(FORMATS)}.", 'unsupported_format')
    if min(width, height) < 300 or max(width, height) > 6000:
        raise BytePlusAssetError(f'Image resolution {width}x{height} is out of bounds. BytePlus requires dimensions between 300px and 6000px.', 'dimensions_out_of_bounds')
    ratio = width / height
    if ratio < .4 or ratio > 2.5:
        raise BytePlusAssetError(f'Image aspect ratio ({ratio:.2f}) is outside the required range (0.4 to 2.5).', 'invalid_aspect_ratio')
    return {'format': format_name, 'width': width, 'height': height, 'ratio': ratio, 'sizeBytes': len(data)}


class BytePlusClient:
    def __init__(self, config=None, transport=None, date=None):
        self.config = config or config_from_env()
        host = urlsplit(self.config['base_url']).hostname
        self.transport = transport or HttpTransport(allowed_hosts={host}, timeout=45)
        self.date = date
        self.groups, self.assets = {}, {}

    @property
    def is_mock(self):
        return self.config['is_mock']

    @property
    def available(self):
        return bool(self.config.get('ak') and self.config.get('sk'))

    def call(self, action, body, signal=None):
        if signal:
            signal.check()
        if self.is_mock:
            return self.mock(action, body)
        if not self.available:
            raise BytePlusAssetError('BytePlus asset credentials are not configured.', 'missing_configuration', 503)
        raw = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
        query = {'Action': action, 'Version': '2024-01-01'}
        signed = sign_request(body=raw, ak=self.config['ak'], sk=self.config['sk'], region=self.config['region'],
            headers={'content-type': 'application/json', 'host': self.config['host']}, query=query, date=self.date)
        url = self.config['base_url'].rstrip('/') + '/?Action=' + quote(action) + '&Version=2024-01-01'
        from apps.generation import provider_errors  # known upward dependency; remove in refactor steps 4/6
        try:
            result = self.transport.request('POST', url, headers=signed['headers'], raw_body=raw.encode(), signal=signal)
        except Exception as exc:
            raise BytePlusAssetError('Network error contacting BytePlus Asset API.', 'network_error', 502, provider_error=provider_errors.local(
                'byteplus-assets', getattr(exc, 'code', None) or 'network_error', str(exc) or type(exc).__name__, phase=action)) from exc
        def record():   # only for a failure: BytePlus's own code, message and ResponseMetadata.RequestId
            return provider_errors.capture('byteplus-assets', phase=action, status=result.status, body=result.text, headers=result.headers)
        try:
            payload = result.json()
        except ValueError as exc:
            raise BytePlusAssetError(f'BytePlus Asset API returned non-JSON response ({result.status}): {result.text[:300]}', 'invalid_response',
                                     result.status, provider_error=record()) from exc
        error = payload.get('ResponseMetadata', {}).get('Error')
        if not result.ok or error:
            error = error or payload.get('error') or {}
            code = error.get('Code') or error.get('code') or 'unknown_error'
            message = error.get('Message') or error.get('message') or result.text[:300]
            if re.search(r'SensitiveContent|Privacy|real person|portrait', code + message, re.I):
                raise BytePlusAssetError('Asset rejected by BytePlus compliance filter: ' + message, 'moderation_rejected', result.status, payload, record())
            raise BytePlusAssetError(f'BytePlus Asset API error ({result.status} {code}): {message}', code, result.status, payload, record())
        return payload.get('Result', payload)

    def create_asset_group(self, name, description='', group_type='AIGC', project_name='default', signal=None):
        return self.call('CreateAssetGroup', {'Name': name, 'Description': description or '', 'GroupType': group_type or 'AIGC', 'ProjectName': project_name or 'default'}, signal)

    def list_asset_groups(self, *, group_type='AIGC', name=None, group_ids=None, max_results=50, next_token=None, project_name='default', signal=None):
        filters = {'GroupType': group_type or 'AIGC'}
        if name: filters['Name'] = name
        if group_ids: filters['GroupIds'] = group_ids
        body = {'Filter': filters, 'MaxResults': max_results or 50}
        if next_token: body['NextToken'] = next_token
        body['ProjectName'] = project_name or 'default'
        return self.call('ListAssetGroups', body, signal)

    def get_asset_group(self, identifier, project_name='default', signal=None):
        return self.call('GetAssetGroup', {'Id': identifier, 'ProjectName': project_name or 'default'}, signal)

    def delete_asset_group(self, identifier, project_name='default', signal=None):
        return self.call('DeleteAssetGroup', {'Id': identifier, 'ProjectName': project_name or 'default'}, signal)

    def create_asset(self, group_id, url, name='', asset_type='Image', project_name='default', moderation=None, signal=None):
        return self.call('CreateAsset', {'GroupId': group_id, 'URL': url, 'Name': name or '', 'AssetType': asset_type or 'Image',
            'ProjectName': project_name or 'default', 'Moderation': moderation or {'Strategy': 'Default'}}, signal)

    def list_assets(self, *, group_type='AIGC', group_ids=None, statuses=None, max_results=50, next_token=None, project_name='default', signal=None):
        filters = {}
        if group_ids: filters['GroupIds'] = group_ids
        if statuses: filters['Statuses'] = statuses
        filters['GroupType'] = group_type or 'AIGC'
        body = {'Filter': filters, 'MaxResults': max_results or 50}
        if next_token: body['NextToken'] = next_token
        body['ProjectName'] = project_name or 'default'
        return self.call('ListAssets', body, signal)

    def get_asset(self, identifier, project_name='default', signal=None):
        return self.call('GetAsset', {'Id': identifier, 'ProjectName': project_name or 'default'}, signal)

    def delete_asset(self, identifier, project_name='default', signal=None):
        return self.call('DeleteAsset', {'Id': identifier, 'ProjectName': project_name or 'default'}, signal)

    def mock(self, action, body):
        now = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        identifier = body.get('Id') or body.get('GroupId') or body.get('AssetId')
        if action == 'CreateAssetGroup':
            identifier = 'group-' + str(uuid.uuid4())
            self.groups[identifier] = {'Id': identifier, **body, 'CreateTime': now, 'UpdateTime': now}
            return {'Id': identifier}
        if action == 'CreateAsset':
            identifier = 'asset-' + str(uuid.uuid4())
            self.assets[identifier] = {'Id': identifier, **body, 'Status': 'Active', 'CreateTime': now, 'UpdateTime': now, 'LastInferenceTime': ''}
            return {'Id': identifier}
        if action in ('GetAssetGroup', 'GetAsset'):
            collection = self.groups if action == 'GetAssetGroup' else self.assets
            if identifier not in collection:
                raise BytePlusAssetError('Asset group not found.' if action == 'GetAssetGroup' else 'Asset not found.', 'NotFound', 404)
            return collection[identifier]
        if action in ('ListAssetGroups', 'ListAssets'):
            rows = list((self.groups if action == 'ListAssetGroups' else self.assets).values())
            if action == 'ListAssets' and body.get('Filter', {}).get('GroupIds'):
                rows = [r for r in rows if r.get('GroupId') in body['Filter']['GroupIds']]
            return {'Items': rows, 'NextToken': ''}
        if action == 'DeleteAssetGroup':
            self.groups.pop(identifier, None)
            self.assets = {key: value for key, value in self.assets.items() if value.get('GroupId') != identifier}
            return {'Id': identifier}
        if action == 'DeleteAsset':
            self.assets.pop(identifier, None)
            return {'Id': identifier}
        raise BytePlusAssetError(f"Mock action '{action}' not implemented.", 'not_implemented')


_client = None

def get_client():
    global _client
    config = config_from_env()
    if _client is None or _client.config != config:
        _client = BytePlusClient(config)
    return _client
