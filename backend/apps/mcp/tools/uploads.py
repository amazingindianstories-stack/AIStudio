"""upload_reference: bring an image, audio or video file into Veevee for use as a generate reference.

Three ways in, all through the web's upload sessions (``apps.media.uploads``), so quotas, size, signature and checksum
checks and owner-only access are the same as for browser uploads:

- ``{url}``: the server fetches a public https URL with the pinned public-DNS fetcher (``integrations.remote``): no
  private or reserved addresses, at most 3 redirects each re-checked, per-kind size caps and a 45 s deadline;
- ``{dataBase64, contentType}``: up to 2.5 MB of decoded bytes inline;
- ``{contentType, byteSize}``: a signed upload URL the agent PUTs the file to, then ``{uploadId}`` finalizes it.

The reference id it returns is an upload id; generate_image and generate_video take it wherever they take a library
generation id. Uploads stay owner-only: another user's upload id is NOT_FOUND through MCP.
"""
import asyncio
import base64
import binascii
import contextlib
import hashlib
import io
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone as tz
from urllib.parse import unquote, urlsplit

from django.conf import settings

from apps.integrations.dns import MediaDNSCapacityError
from apps.integrations.errors import MediaTooLargeError
from apps.integrations.remote import SafeMediaFetcher, UnsafeMediaURL
from apps.media import uploads
from apps.media.models import UploadSession
from apps.media.storage import FileSystemAdapter, get_storage
from apps.mcp_auth import controls
from .. import errors, paid, results
from ..registry import ToolResult, obj, register
from ..runtime import db

MB = 1024 * 1024
KINDS = {'image-reference': 'image', 'audio-reference': 'audio', 'video-reference': 'video'}
IMPORT_BYTES = {'image-reference': 30 * MB, 'audio-reference': 15 * MB, 'video-reference': 200 * MB}
INLINE_BYTES = 2621440                          # 2.5 MB decoded keeps the request under Vercel's 4.5 MB body limit
IMPORT_SECONDS = 45                             # the whole fetch; the call still answers inside the gateway's 55 s wait
IMPORT_REDIRECTS = 3
IMPORTS = 2                                     # URL imports running at once in this process
ALIASES = {'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png'}
USABLE = {'image': ['generate_image.referenceIds', 'generate_video.referenceImageIds', 'generate_video.firstFrameId',
                    'generate_video.lastFrameId'],
          'audio': ['generate_video.referenceAudioIds'],
          'video': ['generate_video.referenceVideoIds']}
DATA_URL = re.compile(r'^data:([^;,]+)?(?:;[^,]*)?;base64,', re.I)

STRING, INTEGER = {'type': 'string'}, {'type': 'integer'}
REFERENCE_SCHEMA = results.obj({
    'id': results.UUID, 'kind': {'enum': ['image', 'audio', 'video']}, 'contentType': STRING, 'bytes': INTEGER,
    'filename': STRING, 'sha256': results.nullable(STRING), 'state': {'enum': ['ready', 'uploading']},
    'usableIn': {'type': 'array', 'items': STRING}})
UPLOAD_SCHEMA = results.obj({
    'url': STRING, 'method': {'const': 'PUT'}, 'headers': {'type': 'object', 'additionalProperties': STRING},
    'expiresAt': STRING, 'uploadedBytes': INTEGER, 'chunkBytes': INTEGER})
UPLOAD_RESULT = results.obj({'outcome': {'enum': ['ready', 'upload_pending']}, 'reference': REFERENCE_SCHEMA,
                             'upload': results.nullable(UPLOAD_SCHEMA), 'next': results.nullable(results.NEXT_SCHEMA)})

_imports = threading.BoundedSemaphore(IMPORTS)
IMPORT_POOL = ThreadPoolExecutor(max_workers=IMPORTS, thread_name_prefix='mcp-import')


class Unsupported(ValueError):
    pass


def fetcher():
    """The public-HTTPS fetcher for URL imports; tests replace it with one that has a fake resolver and connection."""
    return SafeMediaFetcher(None, max_bytes=max(IMPORT_BYTES.values()), timeout=20, total_timeout=IMPORT_SECONDS,
                            max_redirects=IMPORT_REDIRECTS)


def purpose_of(content_type):
    """``(purpose, normalized type)`` for an image, audio or video reference type; ``Unsupported`` otherwise."""
    mime = content_type.split(';', 1)[0].strip().lower() if isinstance(content_type, str) else ''
    mime = ALIASES.get(mime, mime)
    for purpose in KINDS:
        if re.fullmatch(uploads.PURPOSES[purpose][1], mime):
            return purpose, mime
    raise Unsupported(f'Type "{mime or "unknown"}" is not an image, audio or video type Veevee takes as a reference '
                      f'(accepted: image/(jpeg|png|webp|tiff|gif|heic|heif|avif|bmp), audio/(mpeg|mp3|wav|x-wav|wave|ogg|webm|'
                      f'mp4|x-m4a|aac|flac), video/(mp4|quicktime|x-m4v|webm)).')


def megabytes(size):
    return f'{size / MB:g} MB'


def iso(value):
    return value.isoformat().replace('+00:00', 'Z')


def reference(session, digest=None):
    kind = KINDS[session['purpose']]
    return {'id': session['referenceId'], 'kind': kind, 'contentType': session['contentType'], 'bytes': session['byteSize'],
            'filename': session['filename'], 'sha256': digest, 'state': 'ready' if session['state'] == 'ready' else 'uploading',
            'usableIn': USABLE[kind]}


def put_target(session, storage):
    """Where the agent PUTs the file: the storage's resumable session, or a signed local URL on development storage."""
    expires = datetime.fromisoformat(session['expiresAt'])
    if isinstance(storage.primary, FileSystemAdapter):
        token = uploads.sign_upload(session['key'], session['contentType'])
        url = settings.PUBLIC_APP_URL.rstrip('/') + '/api/uploads/local?t=' + token
        expires = min(expires, datetime.fromtimestamp(time.time() + 1800, tz.utc))
    else:
        url = session['uploadUrl']
    return {'url': url, 'method': 'PUT', 'headers': {'Content-Type': session['contentType']}, 'expiresAt': iso(expires),
            'uploadedBytes': session.get('uploadedBytes', 0), 'chunkBytes': session['chunkBytes']}


def pending(session, storage):
    finish = results.call('upload_reference', {'uploadId': session['uploadId']},
                          'Finalizes the upload once every byte is PUT; it checks the size, type and contents.')
    return {'outcome': 'upload_pending', 'reference': reference(session), 'upload': put_target(session, storage), 'next': finish}


def ready(session):
    """A finished upload; runs on a database thread to read the checksum finalize recorded."""
    digest = UploadSession.objects.filter(pk=session['uploadId']).values_list('sha256', flat=True).first()
    return {'outcome': 'ready', 'reference': reference(session, digest or None), 'upload': None, 'next': None}


REJECTED = ('UPLOAD_SIZE_MISMATCH', 'UPLOAD_SIGNATURE_MISMATCH', 'UPLOAD_CHECKSUM_MISMATCH', 'UPLOAD_CONTENT_TYPE_MISMATCH')
UPLOAD_ERRORS = {
    'UPLOAD_NOT_FOUND': (errors.NOT_FOUND, 'No upload {id} of yours exists. Start a new one with upload_reference.'),
    'UPLOAD_CANCELLED': (errors.NOT_FOUND, 'Upload {id} was cancelled. Start a new one with upload_reference.'),
    'UPLOAD_EXPIRED': (errors.NOT_FOUND, 'Upload {id} expired after 24 hours unfinished. Start a new one with upload_reference.'),
    'UPLOAD_SIZE_MISMATCH': (errors.INVALID_INPUT, 'The uploaded bytes do not match byteSize. Start a new upload with the exact size.'),
    'UPLOAD_CONTENT_TYPE_MISMATCH': (errors.INVALID_INPUT, 'The upload was not sent with its Content-Type header. Start a new upload.'),
    'UPLOAD_SIGNATURE_MISMATCH': (errors.INVALID_INPUT, 'The file contents are not a {type} file. Send the real type or another file.'),
    'UPLOAD_CHECKSUM_MISMATCH': (errors.INVALID_INPUT, 'The file does not match its sha256. Start a new upload.'),
    'UPLOAD_TOO_LARGE_OR_EMPTY': (errors.INVALID_INPUT, 'The file is empty or larger than the {limit} limit for this kind.'),
    'INVALID_UPLOAD_METADATA': (errors.INVALID_INPUT, 'The filename or sha256 is not valid.'),
    'UPLOAD_INFLIGHT_LIMIT': (errors.RATE_LIMITED, 'Too many unfinished uploads. Finish or wait for them, then retry.'),
    'UPLOAD_QUOTA_EXCEEDED': (errors.RATE_LIMITED, 'Your unfinished uploads are too large in total. Finish them, then retry.'),
    'UPLOAD_IDEMPOTENCY_CONFLICT': (errors.IDEMPOTENCY_CONFLICT, 'This idempotencyKey was already used for another file. Use a new key.'),
}


def from_upload_error(error, **values):
    code, message = UPLOAD_ERRORS.get(error.code, (errors.INTERNAL_ERROR, 'Veevee could not store this file. Try again in a minute.'))
    return errors.ToolError(code, message.format(**{'id': '', 'type': 'declared', 'limit': 'size', **values}).replace('  ', ' '))


def request_key(call, how, values):
    """The session's per-user replay key: the agent's idempotencyKey, or one derived from token, input and minute."""
    explicit = call.arguments.get('idempotencyKey')
    if explicit:
        return 'mcp:' + hashlib.sha256(explicit.encode()).hexdigest()[:60]
    return paid.derived_key(call.principal, 'upload_reference:' + how, values)


def store(user_id, body, data):
    try:
        return ready(uploads.store_upload(user_id, body, data, get_storage()))
    except uploads.UploadError as error:
        purpose = body['purpose']
        raise from_upload_error(error, type=body['contentType'], limit=megabytes(IMPORT_BYTES.get(purpose, uploads.LIMITS[purpose]))) from None


def filename_from(url):
    name = unquote(urlsplit(url).path.rsplit('/', 1)[-1])
    return ''.join(c for c in name if ord(c) >= 32)[:255]


def inline_bytes(arguments):
    text = arguments['dataBase64'].strip()
    content_type = arguments.get('contentType')
    prefix = DATA_URL.match(text)
    if prefix:
        content_type = content_type or prefix.group(1)
        text = text[prefix.end():]
    if not content_type:
        raise errors.ToolError(errors.INVALID_INPUT, 'contentType is required with dataBase64, for example "image/png".')
    try:
        data = base64.b64decode(re.sub(r'\s+', '', text), validate=True)
    except (binascii.Error, ValueError):
        raise errors.ToolError(errors.INVALID_INPUT, 'dataBase64 is not valid base64.') from None
    if not data or len(data) > INLINE_BYTES:
        raise errors.ToolError(errors.INVALID_INPUT, f'dataBase64 must decode to 1 byte to {megabytes(INLINE_BYTES)}. For a larger '
                               'file send its url, or contentType and byteSize for a signed upload URL.')
    return content_type, data


async def from_inline(call):
    content_type, data = inline_bytes(call.arguments)
    try:
        purpose, mime = purpose_of(content_type)
    except Unsupported as error:
        raise errors.ToolError(errors.INVALID_INPUT, str(error)) from None
    digest = hashlib.sha256(data).hexdigest()
    filename = call.arguments.get('filename', '')
    body = {'purpose': purpose, 'contentType': mime, 'byteSize': len(data), 'filename': filename, 'sha256': digest,
            'requestKey': request_key(call, 'inline', {'contentType': mime, 'sha256': digest, 'filename': filename})}
    return await db(store, call.principal.user.id, body, io.BytesIO(data))


def import_message(error):
    if isinstance(error, Unsupported):
        return str(error)
    if isinstance(error, UnsafeMediaURL):
        return ('The URL must be a public https address on port 443 without a user name or password; private and '
                'reserved networks are refused.')
    if isinstance(error, MediaTooLargeError):
        return ('The file is larger than the URL import limit (image 30 MB, audio 15 MB, video 200 MB). Send contentType '
                'and byteSize for a signed upload URL instead.')
    if isinstance(error, TimeoutError):
        return f'The download did not finish within {IMPORT_SECONDS} s. Send contentType and byteSize for a signed upload URL instead.'
    status = re.search(r'\((\d{3})\)', str(error))
    if status:
        return f'The URL answered HTTP {status.group(1)}. Check that it is public and still valid.'
    if 'redirects' in str(error):
        return f'The URL redirected more than {IMPORT_REDIRECTS} times.'
    return 'The URL could not be downloaded. Check that it is public and still valid.'


async def from_url(call):
    """Fetch on the import pool (never a database thread), then store through the session on the database executor."""
    url, wanted = call.arguments['url'], call.arguments.get('contentType')
    if wanted:
        try:
            purpose_of(wanted)
        except Unsupported as error:
            raise errors.ToolError(errors.INVALID_INPUT, str(error)) from None
    if not _imports.acquire(blocking=False):
        raise errors.ToolError(errors.RATE_LIMITED, f'{IMPORTS} URL imports are already running. Retry in a few seconds.',
                               retry_after_seconds=5)

    def limit_for(header):
        return IMPORT_BYTES[purpose_of(wanted or header)[0]]

    async def run():
        with contextlib.ExitStack() as stack:
            stack.callback(_imports.release)
            def download():
                return stack.enter_context(fetcher().open_file(url, limit_for=limit_for))
            try:
                spool, header = await asyncio.get_running_loop().run_in_executor(IMPORT_POOL, download)
            except MediaDNSCapacityError:
                raise errors.ToolError(errors.RATE_LIMITED, 'Veevee is busy resolving addresses. Retry in a few seconds.',
                                       retry_after_seconds=2) from None
            except (Unsupported, UnsafeMediaURL, MediaTooLargeError, TimeoutError, ValueError, OSError) as error:
                raise errors.ToolError(errors.INVALID_INPUT, import_message(error)) from None
            purpose, mime = purpose_of(wanted or header)
            size = spool.seek(0, 2)
            spool.seek(0)
            digest = hashlib.sha256()
            for chunk in iter(lambda: spool.read(256 * 1024), b''):
                digest.update(chunk)
            spool.seek(0)
            filename = call.arguments.get('filename') or filename_from(url)
            body = {'purpose': purpose, 'contentType': mime, 'byteSize': size, 'filename': filename,
                    'sha256': digest.hexdigest(),
                    'requestKey': request_key(call, 'url', {'url': url, 'contentType': wanted, 'filename': filename})}
            return await db(store, call.principal.user.id, body, spool)

    # A dropped client never abandons a half-stored file: the import finishes (and frees its slot) and a retry replays it.
    return await asyncio.shield(asyncio.ensure_future(run()))


async def start_session(call):
    arguments = call.arguments
    try:
        purpose, mime = purpose_of(arguments['contentType'])
    except Unsupported as error:
        raise errors.ToolError(errors.INVALID_INPUT, str(error)) from None
    body = {'purpose': purpose, 'contentType': mime, 'byteSize': arguments['byteSize'],
            'filename': arguments.get('filename', ''), 'sha256': arguments.get('sha256', '')}
    body['requestKey'] = request_key(call, 'session', {key: value for key, value in body.items() if key != 'purpose'})

    def begin(user_id):
        storage = get_storage()
        try:
            session = uploads.initialize_upload(user_id, body, storage)
        except uploads.UploadError as error:
            if error.code == 'RESUMABLE_STORAGE_UNAVAILABLE':
                raise errors.ToolError(errors.INVALID_INPUT, 'Signed uploads are unavailable on this server. Send url or dataBase64.') from None
            raise from_upload_error(error, type=mime, limit=megabytes(uploads.LIMITS[purpose])) from None
        return ready(session) if session['state'] == 'ready' else pending(session, storage)
    return await db(begin, call.principal.user.id)


async def finish_session(call):
    identifier = call.arguments['uploadId'].lower()

    def complete(user_id):
        storage, session = get_storage(), None
        try:
            session = uploads.upload_status(user_id, identifier, storage)       # owner-only, like the web
            return ready(uploads.finalize_upload(user_id, identifier, storage))
        except uploads.UploadError as error:
            if error.code == 'UPLOAD_INCOMPLETE':
                return pending(session, storage)
            if error.code in REJECTED:
                uploads.cancel_upload(user_id, identifier, storage)               # bytes that fail the checks never linger
            raise from_upload_error(error, id=identifier, type=session['contentType'] if session else 'declared') from None
    return await db(complete, call.principal.user.id)


WAYS = ('url', 'dataBase64', 'byteSize', 'uploadId')


@register(
    name='upload_reference', title='Upload a reference file', scope='veevee.generate', read_only=False, idempotent=True,
    open_world=True,
    description=('Add a reference file (image, audio or video) from a public https URL or small base64 data, for use in '
                 'generate calls.\n'
                 'Send exactly one of: url (public https; image up to 30 MB, audio 15 MB, video 200 MB); dataBase64 with '
                 'contentType (up to 2.5 MB decoded; a data: URL prefix is accepted); contentType and byteSize for a signed '
                 'upload URL (outcome "upload_pending": PUT the whole file to upload.url with upload.headers, then make the '
                 'call in next); or uploadId to finish such an upload. Free; at most 30 uploads an hour per token. '
                 'reference.id goes in the generate fields listed in reference.usableIn, for example referenceAudioIds for '
                 'OmniHuman. Contents are checked against the declared type. The upload URL is a secret: never show it.'),
    input_schema=obj({
        'url': {'type': 'string', 'pattern': '^https://', 'maxLength': 2048, 'description': 'A public https URL of the file.'},
        'dataBase64': {'type': 'string', 'maxLength': 3500000, 'description': 'The file as base64 (2.5 MB decoded at most).'},
        'contentType': {'type': 'string', 'maxLength': 100,
                        'description': 'The MIME type, e.g. image/png, audio/wav, video/mp4. For url it overrides the server\'s header.'},
        'byteSize': {'type': 'integer', 'minimum': 1, 'maximum': uploads.LIMITS['video-reference'],
                     'description': 'Exact size in bytes, for a signed upload URL (image 256 MB, audio 512 MB, video 2 GB).'},
        'sha256': {'type': 'string', 'pattern': '^[0-9a-f]{64}$', 'description': 'Optional checksum checked at finalize.'},
        'uploadId': {**results.UUID, 'description': 'Finish a signed upload after PUTting every byte.'},
        'filename': {'type': 'string', 'maxLength': 255, 'description': 'Optional name to show for the file.'},
        'idempotencyKey': paid.PAID_CONTROLS['idempotencyKey'],
    }),
    output_schema=UPLOAD_RESULT)
async def upload_reference(call):
    arguments = call.arguments
    given = [way for way in WAYS if way in arguments]
    if len(given) != 1:
        raise errors.ToolError(errors.INVALID_INPUT, 'Send exactly one of url, dataBase64, byteSize (with contentType) or uploadId.')
    way = given[0]
    if way == 'byteSize' and 'contentType' not in arguments:
        raise errors.ToolError(errors.INVALID_INPUT, 'A signed upload needs contentType as well as byteSize.')
    if way == 'uploadId' and set(arguments) - {'uploadId'}:
        raise errors.ToolError(errors.INVALID_INPUT, 'Send uploadId alone to finish an upload.')
    if 'sha256' in arguments and way != 'byteSize':
        raise errors.ToolError(errors.INVALID_INPUT, 'sha256 is only for signed uploads; Veevee hashes url and dataBase64 files itself.')
    if way != 'uploadId':
        await db(controls.check_rate, call.principal, 'uploads')
    handler = {'url': from_url, 'dataBase64': from_inline, 'byteSize': start_session, 'uploadId': finish_session}[way]
    structured = await handler(call)
    found = structured['reference']
    call.record['referenceId'] = found['id']
    if structured['outcome'] == 'ready':
        sentence = f"The {found['kind']} reference {found['id']} is ready ({megabytes(found['bytes'])})."
    else:
        sentence = f"Upload {found['id']} is waiting for its bytes: PUT the file to upload.url, then call upload_reference with uploadId."
    return ToolResult(structured, sentence, outcome=structured['outcome'])
