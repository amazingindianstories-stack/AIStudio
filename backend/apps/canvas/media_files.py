"""Existing upload manifests and private storage back reusable board files.

SVG/PSD/PDF work is queued in Postgres and performed in a generation-worker slot.
Only pixel derivatives are published for SVG/PSD. Video bytes are copied unchanged.
"""
import re
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from uuid import uuid4
from django.conf import settings
from django.db import transaction, connections
from django.db.models import F, Q
from apps.media import storage as media_storage
from apps.media.storage import MIME

def get_storage():
    return media_storage.get_storage()
from apps.media.uploads import resolve_ready_upload, UploadError, LIMITS
from .models import BoardMedia

RASTER_TYPES = {'image/svg+xml', 'image/vnd.adobe.photoshop', 'image/x-photoshop', 'application/pdf'}
MAX_PIXELS = 40_000_000
MAX_PAGES = 200
MAX_ATTEMPTS = 3
EXTENSIONS = {**{mime: ext for ext, mime in MIME.items()}, 'application/pdf': 'pdf',
              'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/webm': 'webm'}


def now_ms():
    return int(time.time() * 1000)


def describe(row):
    return {'id': str(row.id), 'state': row.state, 'name': row.name, 'contentType': row.content_type,
            'url': '/api/media/' + row.key if row.state == 'ready' else None,
            'pages': row.pages, 'naturalW': row.width, 'naturalH': row.height, 'error': row.error}


def import_manifest(actor, board_id, reference_id):
    upload = resolve_ready_upload(str(actor.id), reference_id, purposes={'canvas'})
    if upload.content_type.startswith('video/') and upload.byte_size > 150 * 1024 * 1024:
        raise UploadError('Board videos must be 150 MiB or smaller.')
    existing = BoardMedia.objects.filter(board_id=board_id, reference_id=upload.id).first()
    if existing:
        return existing
    return register(actor, board_id, upload.key, upload.content_type, upload.filename or 'Uploaded file', upload.id)


def register(actor, board_id, source_key, content_type, name, reference_id=None):
    # get_or_create makes retried manifest publication idempotent; unfinished files
    # never appear in the library. Non-converted masters are copied byte for byte.
    row, created = BoardMedia.objects.get_or_create(board_id=board_id, reference_id=reference_id,
        defaults={'id': uuid4(), 'actor_id': actor.id, 'name': name[:255], 'source_key': source_key,
                  'content_type': content_type, 'created_at': now_ms(),
                  'state': 'queued' if content_type in RASTER_TYPES else 'running',
                  'lease_until': 0 if content_type in RASTER_TYPES else now_ms() + 300_000}) if reference_id else (BoardMedia.objects.create(
            id=uuid4(), board_id=board_id, actor_id=actor.id, name=name[:255], source_key=source_key,
            content_type=content_type, created_at=now_ms(),
            state='queued' if content_type in RASTER_TYPES else 'running',
            lease_until=0 if content_type in RASTER_TYPES else now_ms() + 300_000), True)
    if created and content_type not in RASTER_TYPES:
        storage = get_storage()
        key = f'canvas/{board_id}/{row.id}.{EXTENSIONS.get(content_type, "bin")}'
        try:
            copy_to(storage, source_key, key, content_type)
            row.key, row.state = key, 'ready'
            row.save(update_fields=['key', 'state'])
        except Exception:
            row.state, row.error = 'failed', 'Could not store this file. Upload it again.'
            row.save(update_fields=['state', 'error'])
            raise
    return row


def copy_to(storage, source, target, mime):
    incoming = storage.open(source)
    try:
        with tempfile.TemporaryFile() as staged:
            total = 0
            for chunk in incoming.stream:
                total += len(chunk)
                if total > LIMITS['canvas']:
                    raise ValueError('File exceeds the canvas upload limit.')
                staged.write(chunk)
            staged.seek(0)
            storage.upload_stream(staged, target, mime, 'private, max-age=0')
    finally:
        incoming.stream.close()


def safe_svg(data):
    """Raster input cannot resolve URLs, XML entities, CSS imports or foreign markup.

    Preserve normal text and inline SVG styling; refuse remote references instead of
    rendering a misleading partial image. Raster output contains no active SVG.
    """
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('SVG files must be 8 MiB or smaller.')
    text = data.decode('utf-8-sig')
    if re.search(r'<!\s*(?:DOCTYPE|ENTITY)|<\?xml-stylesheet', text, re.I):
        raise ValueError('SVG entities and external stylesheets are not supported.')
    root = ET.fromstring(text)
    if root.tag.split('}')[-1] != 'svg':
        raise ValueError('Expected an SVG image.')
    for element in root.iter():
        tag = element.tag.split('}')[-1]
        if tag in ('script', 'foreignObject', 'style', 'image', 'feImage'):
            raise ValueError('SVG scripts, stylesheets and embedded images are not supported.')
        for name, value in element.attrib.items():
            local = name.split('}')[-1].lower()
            if local.startswith('on') or local == 'base':
                raise ValueError('SVG event handlers and base URLs are not supported.')
            if local in ('href', 'src') and not value.startswith('#'):
                raise ValueError('SVG external references are not supported.')
            if re.search(r'url\s*\(\s*[\'"]?\s*(?!#)|@import|\\|javascript:', value, re.I):
                raise ValueError('SVG external styles are not supported.')
    return ET.tostring(root, encoding='utf-8')


def queued_media():
    """One candidate; claim happens in the worker thread under a row lock."""
    return BoardMedia.objects.filter(Q(state='queued') | Q(state='running', lease_until__lt=now_ms())).order_by('created_at').first()


def publish(storage, row, token, **fields):
    """Mark the leased row ready; a URL import's staged original is no longer needed."""
    if BoardMedia.objects.filter(pk=row.id, lease_token=token).update(state='ready', lease_token=None, lease_until=0, **fields):
        if row.source_key.startswith('canvas-imports/'):
            storage.primary.delete(row.source_key)
    return 'media_ready'


def process_media(identifier, stop=None):
    """One leased job per worker slot, one PDF page at a time, bounded output size."""
    if settings.LOCAL_DATA_MODE == 'read_only_viewer' or stop and stop.is_set():
        return 'stopped'
    token = uuid4()
    try:
        with transaction.atomic():
            row = BoardMedia.objects.select_for_update().get(pk=identifier)
            if row.state not in ('queued', 'running') or row.state == 'running' and row.lease_until >= now_ms():
                return 'unclaimed'
            if row.attempts >= MAX_ATTEMPTS:
                row.state, row.lease_token, row.lease_until = 'failed', None, 0
                row.error = f'Could not process this file after {MAX_ATTEMPTS} attempts. Upload a valid file again.'
                row.save(update_fields=['state', 'lease_token', 'lease_until', 'error'])
                return 'media_failed'
            row.state, row.lease_token, row.lease_until = 'running', token, now_ms() + 300_000
            row.attempts += 1
            row.save(update_fields=['state', 'lease_token', 'lease_until', 'attempts'])
        storage = get_storage()
        if row.content_type not in RASTER_TYPES:
            key = f'canvas/{row.board_id}/{row.id}.{EXTENSIONS.get(row.content_type, "bin")}'
            copy_to(storage, row.source_key, key, row.content_type)
            return publish(storage, row, token, key=key)
        import pyvips
        with tempfile.TemporaryDirectory(prefix='board-media-') as directory:
            source = Path(directory) / 'source'
            incoming = storage.open(row.source_key)
            try:
                total = 0
                with source.open('wb') as staged:
                    for chunk in incoming.stream:
                        total += len(chunk)
                        if total > LIMITS['canvas']:
                            raise ValueError('File exceeds the canvas upload limit.')
                        staged.write(chunk)
            finally:
                incoming.stream.close()
            with source.open('rb') as probe:
                prefix = probe.read(4)
            is_pdf = row.content_type == 'application/pdf'
            if row.content_type == 'image/svg+xml':
                source.write_bytes(safe_svg(source.read_bytes()))
                loader = pyvips.Image.svgload
            elif is_pdf:
                if prefix != b'%PDF':
                    raise ValueError('Invalid PDF file.')
                loader = pyvips.Image.pdfload
            else:
                if prefix != b'8BPS':
                    raise ValueError('Invalid Photoshop file.')
                loader = pyvips.Image.magickload
            header = loader(str(source), access='sequential')
            pages = int(header.get('n-pages')) if is_pdf and header.get_typeof('n-pages') else 1
            if not 1 <= pages <= MAX_PAGES:
                raise ValueError(f'PDFs must contain at most {MAX_PAGES} pages.')
            key = f'canvas/{row.board_id}/{row.id}.{"pdf" if is_pdf else "png"}'
            width, height = header.width, header.height
            if width * height > MAX_PIXELS:
                raise ValueError('Page exceeds the 40 megapixel limit.')
            for page in range(pages):
                if stop and stop.is_set():
                    BoardMedia.objects.filter(pk=row.id, lease_token=token).update(
                        state='queued', lease_token=None, lease_until=0, attempts=F('attempts') - 1)
                    return 'stopped'
                if not BoardMedia.objects.filter(pk=row.id, lease_token=token).update(lease_until=now_ms() + 300_000):
                    return 'unclaimed'
                image = loader(str(source), page=page, access='sequential') if is_pdf else header
                if image.width * image.height > MAX_PIXELS:
                    raise ValueError('Page exceeds the 40 megapixel limit.')
                if is_pdf:
                    image = image.thumbnail_image(2048, height=2048, size='down')
                output = Path(directory) / 'page.png'
                image.pngsave(str(output), compression=6)
                with output.open('rb') as data:
                    storage.upload_stream(data, f'{key}.pages/{page+1}.png' if is_pdf else key,
                                          'image/png', 'private, max-age=0')
            if is_pdf:
                copy_to(storage, row.source_key, key, 'application/pdf')
            return publish(storage, row, token, key=key, pages=pages, width=width, height=height, error='')
    except Exception:
        # No parser diagnostics, file contents, paths or provider addresses in UI/logs.
        BoardMedia.objects.filter(pk=identifier, lease_token=token).update(
            state='failed', error='Could not render file. Use a valid SVG, flattened PSD, or PDF with at most 200 pages and 40 megapixels per page.', lease_until=0)
        return 'media_failed'


def handle_media(identifier, stop=None):
    try:
        return process_media(identifier, stop)
    finally:
        connections.close_all()
