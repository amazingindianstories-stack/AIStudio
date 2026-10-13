"""BytePlus client limited to the unbilled GetAsset read."""
import json
import re
from urllib.parse import parse_qs, urlsplit
from apps.generation.providers.transport import HttpTransport

GETASSET_HOST = 'ark.ap-southeast-1.byteplusapi.com'
ASSET_ID = re.compile(r'[A-Za-z0-9_-]{1,256}')


class ReadOnlyGetAssetTransport(HttpTransport):
    """Permits only POST /?Action=GetAsset&Version=2024-01-01 with {Id, ProjectName}."""
    unbilled_readonly = True

    def request(self, method, url, **kwargs):
        parts = urlsplit(url)
        query = parse_qs(parts.query)
        if (method != 'POST' or parts.scheme != 'https' or parts.netloc != GETASSET_HOST or parts.path != '/'
                or query != {'Action': ['GetAsset'], 'Version': ['2024-01-01']}):
            raise ValueError('GetAsset target mismatch')
        payload = json.loads(kwargs.get('raw_body') or b'{}')
        if set(payload) != {'Id', 'ProjectName'} or not ASSET_ID.fullmatch(payload.get('Id', '')) or payload['ProjectName'] != 'default':
            raise ValueError('GetAsset payload mismatch')
        return super().request(method, url, **kwargs)


def get_asset_client():
    from .byteplus import BytePlusClient, config_from_env
    config = config_from_env()
    config['is_mock'] = False
    return BytePlusClient(config=config, transport=ReadOnlyGetAssetTransport(allowed_hosts={GETASSET_HOST}, timeout=2))
