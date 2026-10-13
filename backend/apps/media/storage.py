"""Byte-preserving storage with explicit, dependency-injectable backends.

Fallbacks apply only to missing objects, never permission/timeout failures.
Closing a response closes its upstream stream, including abandoned downloads.
"""
import base64
from dataclasses import dataclass
from datetime import timedelta
import io
import hashlib
import json
from pathlib import Path
import re
import unicodedata
from urllib.parse import quote, urlsplit
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.utils.module_loading import import_string
from .keys import validate_key, media_key_from_ref, InvalidMediaKey, is_export_key
from .errors import MediaTooLargeError


class MediaNotFoundError(FileNotFoundError):
    pass


class InvalidMediaRangeError(ValueError):
    pass


def attachment_disposition(filename):
    """One safe header for cloud overrides and local attachment responses."""
    if not isinstance(filename, str) or not filename:
        raise ValueError('Invalid attachment filename.')
    filename = unicodedata.normalize('NFC', filename)
    if (len(filename.encode('utf-8')) > 255 or filename in ('.', '..')
            or any(ord(c) < 32 or ord(c) == 127 for c in filename)
            or any(c in filename for c in '/\\')):
        raise ValueError('Invalid attachment filename.')
    ascii_name = ''.join(c if 32 <= ord(c) < 127 and c not in '"\\' else '_' for c in filename)
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


def validate_gcs_session_uri(uri):
    """Session bearers may only target the native GCS HTTPS authority."""
    parsed = urlsplit(uri)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port
            or parsed.fragment or not (host == 'storage.googleapis.com'
                or re.fullmatch(r'[a-z0-9][a-z0-9.-]*\.storage\.googleapis\.com', host))):
        raise ValueError('Unsafe resumable upload session.')
    return uri


def parse_range(value, size):
    match = re.fullmatch(r'bytes=([0-9]*)-([0-9]*)', value or '')
    if not match or not any(match.groups()) or size <= 0:
        raise InvalidMediaRangeError()
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise InvalidMediaRangeError()
        start, end = max(0, size-suffix), size-1
    else:
        start, end = int(first), int(last) if last else size-1
    if start >= size or end < start:
        raise InvalidMediaRangeError()
    return start, min(end, size-1)


class BoundedStream:
    def __init__(self, stream, length):
        self.stream, self.remaining = stream, length

    def __iter__(self):
        try:
            while self.remaining:
                part = self.stream.read(min(self.remaining, 256*1024))
                if not part:
                    raise IOError('Media object ended before its declared length')
                self.remaining -= len(part)
                yield part
        finally:
            self.close()

    def close(self):
        self.stream.close()


@dataclass
class MediaObject:
    stream: object
    content_type: str
    content_length: int
    status: int = 200
    content_range: str | None = None
    sha256: str | None = None
    crc32c: str | None = None


def _media(stream, size, content_type, range_header=None):
    if range_header:
        start, end = parse_range(range_header, size)
        stream.seek(start)
        return MediaObject(BoundedStream(stream, end-start+1), content_type, end-start+1,
                           206, f'bytes {start}-{end}/{size}')
    return MediaObject(BoundedStream(stream, size), content_type, size)


MIME = {'jpg':'image/jpeg', 'jpeg':'image/jpeg', 'mov':'video/quicktime',
        'mp4':'video/mp4', 'webm':'video/webm', 'json':'application/json',
        'mp3':'audio/mpeg', 'wav':'audio/wav', 'png':'image/png',
        'webp':'image/webp', 'gif':'image/gif', 'avif':'image/avif', 'tiff':'image/tiff',
        'heic':'image/heic', 'heif':'image/heif', 'bmp':'image/bmp'}


class MemoryAdapter:
    """Explicit test adapter; never selected implicitly by production."""
    def __init__(self):
        self.objects = {}

    def put(self, key, data, content_type, cache_control):
        self.objects[key] = bytes(data), content_type

    def put_stream(self, key, stream, content_type, cache_control):
        chunks = []
        while chunk := stream.read(256*1024):
            chunks.append(chunk)
        data = b''.join(chunks)
        self.put(key,data,content_type,cache_control)
        return len(data)

    def open(self, key, range_header=None):
        if key not in self.objects:
            raise MediaNotFoundError(key)
        data, mime = self.objects[key]
        media = _media(io.BytesIO(data), len(data), mime, range_header)
        if not range_header:
            media.sha256 = hashlib.sha256(data).hexdigest()
        return media

    def delete(self, key):
        self.objects.pop(key, None)

    def signed_upload_url(self, key, content_type):
        return f'https://storage.invalid/upload/{quote(key)}?content-type={quote(content_type)}'

    def signed_download_url(self, key, filename, disposition):
        return None

    def browser_url(self, key):
        return None

    def check_connectivity(self):
        return True

    def signed_read_url(self, key, seconds):
        return f'https://storage.invalid/read/{quote(key)}?expires={seconds}'

    def create_resumable_upload_session(self, key):
        return f'https://storage.invalid/resumable/{quote(key)}'


class FileSystemAdapter:
    """Explicit local-only object store. Metadata and bytes use separate roots."""
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key, namespace='objects'):
        validate_key(key, private=True)
        path = self.root / namespace / key
        if not path.resolve().is_relative_to(self.root / namespace):
            raise InvalidMediaKey('Storage path escapes root')
        return path

    def put(self, key, data, content_type, cache_control):
        from uuid import uuid4
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        temporary = dest.with_name(dest.name + '.' + str(uuid4()) + '.tmp')
        temporary.write_bytes(data)
        temporary.replace(dest)
        metadata = self._path(key, 'metadata')
        metadata.parent.mkdir(parents=True, exist_ok=True)
        metadata.write_text(json.dumps({'content_type':content_type, 'cache_control':cache_control,
                                       'sha256': hashlib.sha256(data).hexdigest()}))

    def open(self, key, range_header=None):
        path = self._path(key)
        try:
            stream = path.open('rb')
        except FileNotFoundError as error:
            raise MediaNotFoundError(key) from error
        try:
            metadata = self._path(key, 'metadata')
            properties = json.loads(metadata.read_text()) if metadata.exists() else {}
            media = _media(stream, path.stat().st_size, properties.get('content_type') or 'application/octet-stream', range_header)
            if not range_header:
                media.sha256 = properties.get('sha256')
            return media
        except Exception:
            stream.close()
            raise

    def put_stream(self, key, stream, content_type, cache_control):
        from uuid import uuid4
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        temporary = dest.with_name(dest.name+'.'+str(uuid4())+'.tmp')
        count = 0
        digest = hashlib.sha256()
        try:
            with temporary.open('wb') as output:
                while chunk := stream.read(256*1024):
                    output.write(chunk)
                    digest.update(chunk)
                    count += len(chunk)
            temporary.replace(dest)
            metadata = self._path(key,'metadata')
            metadata.parent.mkdir(parents=True,exist_ok=True)
            metadata.write_text(json.dumps({'content_type':content_type,'cache_control':cache_control,
                                           'sha256':digest.hexdigest()}))
            return count
        finally:
            temporary.unlink(missing_ok=True)

    def delete(self, key):
        for namespace in ('objects', 'metadata'):
            self._path(key, namespace).unlink(missing_ok=True)

    def signed_upload_url(self, key, content_type):
        from .uploads import sign_upload
        return '/api/uploads/local?t=' + quote(sign_upload(key, content_type), safe='')

    def signed_download_url(self, key, filename, disposition):
        return None

    def browser_url(self, key):
        return None

    def check_connectivity(self):
        return self.root.is_dir()

    def signed_read_url(self, key, seconds, *, actor_id=None):
        from .grants import media_grant_url
        return media_grant_url(key,seconds,actor_id=actor_id)

    def create_resumable_upload_session(self, key):
        return self.signed_upload_url(key,'application/zip')


def _missing(error):
    code = getattr(error, 'code', None)
    response = getattr(error, 'response', {})
    return code in (404, '404') or response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound')


class GCSAdapter:
    def __init__(self, client, bucket, *, timeout=15, cdn_url='', service_account_email=None):
        self.client, self.bucket, self.timeout, self.cdn_url = client, bucket, timeout, cdn_url
        self.service_account_email = service_account_email

    def open(self, key, range_header=None):
        blob = self.client.bucket(self.bucket).blob(key)
        try:
            blob.reload(timeout=self.timeout)
            size = int(blob.size or 0)
            if range_header:
                parse_range(range_header, size)
            # BlobReader fetches bounded ranges lazily; closing it cancels further reads.
            stream = blob.open('rb', chunk_size=256*1024, timeout=self.timeout)
            media = _media(stream, size, blob.content_type or 'application/octet-stream', range_header)
            if not range_header:
                checksum = getattr(blob, 'crc32c', None)
                media.crc32c = checksum if isinstance(checksum, str) else None
            return media
        except Exception as error:
            if _missing(error):
                raise MediaNotFoundError(key) from error
            raise

    def put(self, key, data, content_type, cache_control):
        blob = self.client.bucket(self.bucket).blob(key)
        blob.cache_control = cache_control
        blob.upload_from_string(data, content_type=content_type, checksum='crc32c', timeout=self.timeout)

    def put_stream(self, key, stream, content_type, cache_control):
        start = stream.tell()
        blob = self.client.bucket(self.bucket).blob(key)
        blob.cache_control = cache_control
        blob.upload_from_file(stream,content_type=content_type,checksum='crc32c',timeout=self.timeout)
        return stream.tell()-start

    def delete(self, key):
        try:
            self.client.bucket(self.bucket).blob(key).delete(timeout=self.timeout)
        except Exception as error:
            if not _missing(error):
                raise

    def signed_upload_url(self, key, content_type):
        return self._signed_url(key,
            version='v4', expiration=timedelta(minutes=30), method='PUT', content_type=content_type)

    def signed_download_url(self, key, filename, disposition):
        return self._signed_url(key,
            version='v4', expiration=timedelta(minutes=5), method='GET', response_disposition=disposition)

    def _signed_url(self, key, **options):
        if self.service_account_email:
            # Python GCS supports IAM signBlob with an impersonated access token;
            # no service account private key needs to exist in the application.
            from google.auth.transport.requests import Request
            credentials = self.client._credentials
            if not credentials.valid:
                credentials.refresh(Request())
            options.update(service_account_email=self.service_account_email,access_token=credentials.token)
        return self.client.bucket(self.bucket).blob(key).generate_signed_url(**options)

    def browser_url(self, key):
        return self.cdn_url.rstrip('/') + '/' + quote(key, safe='/') if self.cdn_url else None

    def check_connectivity(self):
        self.client.bucket(self.bucket).reload(timeout=self.timeout)
        return True

    def signed_read_url(self, key, seconds):
        return self._signed_url(key,
            version='v4',expiration=timedelta(seconds=seconds),method='GET')

    def create_resumable_upload_session(self, key):
        blob = self.client.bucket(self.bucket).blob(key)
        blob.cache_control = 'private, max-age=0, no-store'
        blob.content_disposition = 'attachment; filename=veevee-assets.zip'
        return blob.create_resumable_upload_session(content_type='application/zip',timeout=self.timeout)

    def begin_reference_upload(self, key, content_type, size, origin=None):
        """Native GCS session; size and precondition bind one immutable object."""
        blob = self.client.bucket(self.bucket).blob(key)
        blob.cache_control = 'private, no-store'
        return blob.create_resumable_upload_session(content_type=content_type,
            size=size, origin=origin, if_generation_match=0, timeout=self.timeout)

    def upload_metadata(self, key):
        blob = self.client.bucket(self.bucket).blob(key)
        try:
            blob.reload(timeout=self.timeout)
            return {'size': int(blob.size or 0), 'contentType': blob.content_type,
                    'generation': str(blob.generation), 'crc32c': blob.crc32c}
        except Exception as error:
            if _missing(error):
                raise MediaNotFoundError(key) from error
            raise


class S3Adapter:
    def __init__(self, client, bucket):
        self.client, self.bucket = client, bucket

    def open(self, key, range_header=None):
        try:
            metadata = self.client.head_object(Bucket=self.bucket, Key=key)
            size = int(metadata.get('ContentLength', 0))
            parsed = parse_range(range_header, size) if range_header else None
            options = {'Bucket':self.bucket, 'Key':key}
            if metadata.get('VersionId'):
                options['VersionId'] = metadata['VersionId']
            elif metadata.get('ETag'):
                options['IfMatch'] = metadata['ETag']
            if parsed:
                options['Range'] = f'bytes={parsed[0]}-{parsed[1]}'
            result = self.client.get_object(**options)
            length = parsed[1]-parsed[0]+1 if parsed else size
            media = MediaObject(BoundedStream(result['Body'], length),
                result.get('ContentType') or 'application/octet-stream', length,
                206 if parsed else 200, f'bytes {parsed[0]}-{parsed[1]}/{size}' if parsed else None)
            # Multipart composite hashes are not hashes of the whole stream.
            # Use only explicitly full-object checksums returned by S3.
            if not parsed and result.get('ChecksumType') == 'FULL_OBJECT':
                if result.get('ChecksumSHA256'):
                    media.sha256 = base64.b64decode(result['ChecksumSHA256'], validate=True).hex()
                media.crc32c = result.get('ChecksumCRC32C')
            return media
        except Exception as error:
            if _missing(error):
                raise MediaNotFoundError(key) from error
            raise

    def put(self, key, data, content_type, cache_control):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, CacheControl=cache_control)

    def put_stream(self, key, stream, content_type, cache_control):
        start = stream.tell()
        stream.seek(0,2)
        count = stream.tell()-start
        stream.seek(start)
        self.client.upload_fileobj(stream,self.bucket,key,ExtraArgs={'ContentType':content_type,'CacheControl':cache_control})
        return count

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def signed_upload_url(self, key, content_type):
        return self.client.generate_presigned_url('put_object', Params={'Bucket':self.bucket, 'Key':key,
            'ContentType':content_type}, ExpiresIn=1800)

    def signed_download_url(self, key, filename, disposition):
        return self.client.generate_presigned_url('get_object', Params={'Bucket':self.bucket, 'Key':key,
            'ResponseContentDisposition':disposition}, ExpiresIn=300)

    def browser_url(self, key):
        return None

    def check_connectivity(self):
        self.client.head_bucket(Bucket=self.bucket)
        return True

    def signed_read_url(self, key, seconds):
        return self.client.generate_presigned_url('get_object',Params={'Bucket':self.bucket,'Key':key},ExpiresIn=seconds)

    def create_resumable_upload_session(self, key):
        raise ValueError('Resumable export upload sessions require the GCS backend.')


class StorageService:
    def __init__(self, primary, fallback=None, *, reference_fetcher=None):
        self.primary, self.fallback = primary, fallback
        self.reference_fetcher = reference_fetcher

    def open(self, key, range_header=None):
        validate_key(key)
        try:
            return self.primary.open(key, range_header)
        except MediaNotFoundError:
            if self.fallback:
                return self.fallback.open(key, range_header)
            raise

    def read(self, key):
        media = self.open(key)
        try:
            return b''.join(media.stream)
        finally:
            media.stream.close()

    def write_private_buffer(self, data, key, content_type='application/octet-stream'):
        validate_key(key, private=True)
        self.primary.put(key, bytes(data), content_type, 'private, no-store')

    def read_private_buffer(self, key):
        validate_key(key, private=True)
        media = self.primary.open(key)
        try:
            return b''.join(media.stream)
        finally:
            media.stream.close()

    def check_connectivity(self):
        return self.primary.check_connectivity()

    def upload_stream(self, stream, key, content_type='application/zip', cache_control='private, max-age=0'):
        validate_key(key)
        return self.primary.put_stream(key,stream,content_type,cache_control)

    def create_resumable_upload_session(self, key):
        validate_key(key)
        if not key.startswith('exports/'):
            raise InvalidMediaKey('Invalid export object key.')
        return self.primary.create_resumable_upload_session(key)

    def signed_read_url(self, key, seconds=900, *, actor_id=None):
        validate_key(key)
        from .grants import authorize_upload_read
        authorize_upload_read(key, actor_id)
        adapter = self._read_adapter(key)
        if isinstance(adapter, FileSystemAdapter):
            return adapter.signed_read_url(key,seconds,actor_id=actor_id)
        return adapter.signed_read_url(key,seconds)

    def _read_adapter(self, key):
        if not self.fallback:
            return self.primary
        try:
            media = self.primary.open(key)
            media.stream.close()
            return self.primary
        except MediaNotFoundError:
            return self.fallback

    def exists(self, key):
        try:
            media = self.open(key)
            media.stream.close()
            return True
        except MediaNotFoundError:
            return False

    def upload_buffer(self, data, key, ext):
        validate_key(key)
        self.primary.put(key, bytes(data), MIME.get(ext.lower(), 'application/octet-stream'),
                         'public, max-age=31536000, immutable')
        # Masters are immutable original bytes; only separate derivatives are encoded.
        try:
            from .images import write_thumbnails
            write_thumbnails(bytes(data), key, storage=self)
        except Exception:
            pass
        return '/api/media/' + quote(key, safe='/')

    def upload_base64(self, data, key, ext):
        return self.upload_buffer(base64.b64decode(data, validate=True), key, ext)

    def delete_by_urls(self, urls):
        for url in urls:
            key = media_key_from_ref(url, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
            if key:
                try:
                    self.primary.delete(key)
                except Exception:
                    pass

    def signed_upload_url(self, key, content_type):
        return self.primary.signed_upload_url(validate_key(key), content_type)

    def signed_download_url(self, key, filename, disposition):
        validate_key(key)
        if is_export_key(key):
            raise ValueError('Export archives require their owned download route.')
        return self._read_adapter(key).signed_download_url(key, filename, disposition)

    def signed_export_download_url(self, key, filename):
        """Five-minute attachment grant; filesystem caller streams locally."""
        validate_key(key)
        if not key.startswith('exports/'):
            raise InvalidMediaKey('Invalid export object key.')
        # The owned export route is the only caller of this archive capability.
        # Ordinary media signing intentionally rejects the private namespace.
        return self._read_adapter(key).signed_download_url(key, filename, attachment_disposition(filename))

    def browser_url(self, key):
        validate_key(key)
        return self._read_adapter(key).browser_url(key)

    def read_as_base64(self, ref, *, max_bytes=None):
        return self._read_reference(ref,max_bytes=max_bytes,base64_output=True)

    def read_reference_bytes(self, ref, *, max_bytes=None):
        """Read original bytes without an intermediate base64 allocation."""
        return self._read_reference(ref,max_bytes=max_bytes,base64_output=False)

    def _read_reference(self, ref, *, max_bytes, base64_output):
        def check(size):
            if max_bytes is not None and size > max_bytes:
                raise MediaTooLargeError("Media exceeds the configured input size limit.")
        if not isinstance(ref, str):
            raise ValueError('Unsupported media reference format')
        match = re.fullmatch(r'data:([^;]+);base64,(.*)', ref, re.S)
        if match:
            if max_bytes is not None:
                padding = len(match[2]) - len(match[2].rstrip("="))
                check((len(match[2])//4)*3 - padding)
            decoded = base64.b64decode(match[2], validate=True)
            check(len(decoded))
            return {'mimeType':match[1], 'data':match[2]} if base64_output else {'mimeType':match[1], 'bytes':decoded}
        key = media_key_from_ref(ref, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
        if key:
            if is_export_key(key):
                raise ValueError('Export archives cannot be used as media references.')
            media = self.open(key)
            try:
                check(media.content_length)
                incoming = io.BytesIO()
                for chunk in media.stream:
                    check(incoming.tell()+len(chunk))
                    incoming.write(chunk)
                data = incoming.getvalue()
                return {'mimeType':media.content_type, 'data':base64.b64encode(data).decode()} if base64_output else {'mimeType':media.content_type,'bytes':data}
            finally:
                media.stream.close()
        # Arbitrary untrusted URLs never trigger an implicit network fetch/SSRF.
        if self.reference_fetcher and ref.startswith(('https://', 'http://')):
            from .remote import SafeMediaFetcher
            if isinstance(self.reference_fetcher, SafeMediaFetcher):
                with self.reference_fetcher.open_file(ref,max_bytes=max_bytes) as (stream,mime):
                    data = stream.read()
            else:
                data, mime = self.reference_fetcher(ref)
            check(len(data))
            return {'mimeType':mime, 'data':base64.b64encode(data).decode()} if base64_output else {'mimeType':mime,'bytes':data}
        raise ValueError('Unsupported media reference format')


def configured_storage():
    """Lazy factory; importing views does not initialize credentials or clients."""
    config = getattr(settings, 'VEEVEE_MEDIA_CONFIG', {})
    from .remote import get_media_fetcher
    reference_fetcher = get_media_fetcher()
    backend = config.get('backend')
    if backend == 'filesystem':
        return StorageService(FileSystemAdapter(config['root']),reference_fetcher=reference_fetcher)
    if backend == 'gcs':
        from google.cloud import storage
        client = storage.Client(project=config.get('project'))
        signing = {'service_account_email':config.get('service_account_email')}
        primary = GCSAdapter(client, config['bucket'], cdn_url=config.get('cdn_url', ''),**signing)
        fallback = GCSAdapter(client, config['fallback_bucket'],**signing) if config.get('fallback_bucket') else None
        if config.get('legacy_s3_bucket'):
            import boto3
            from botocore.config import Config
            legacy_client = boto3.client('s3',region_name=config.get('legacy_s3_region','us-east-1'),
                config=Config(connect_timeout=15,read_timeout=15,retries={'max_attempts':2}))
            legacy = S3Adapter(legacy_client,config['legacy_s3_bucket'])
            if fallback:
                fallback = StorageService(fallback,legacy)
            else:
                fallback = legacy
        return StorageService(primary, fallback, reference_fetcher=reference_fetcher)
    if backend == 's3':
        import boto3
        from botocore.config import Config
        client = boto3.client('s3', region_name=config.get('region', 'us-east-1'),
            config=Config(connect_timeout=15, read_timeout=15, retries={'max_attempts':2}))
        return StorageService(S3Adapter(client, config['bucket']),reference_fetcher=reference_fetcher)
    raise ImproperlyConfigured('Explicit VEEVEE_MEDIA_STORAGE or VEEVEE_MEDIA_CONFIG is required.')


def get_storage():
    instance = getattr(settings, 'VEEVEE_MEDIA_STORAGE', None)
    if isinstance(instance, str):
        instance = import_string(instance)
    if instance is None:
        return configured_storage()
    return instance() if callable(instance) else instance
