"""Board media endpoints: authenticated, role checked, bounded public-HTTPS fetches."""
import hashlib
import io
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from uuid import uuid4
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.db.models import Q
from apps.authentication.session import lookup
from apps.integrations.remote import SafeMediaFetcher, UnsafeMediaURL
from apps.media.storage import get_storage
from apps.media.uploads import PURPOSES, LIMITS, _sniff
from . import access
from .models import BoardMedia
from .media_files import register, describe, RASTER_TYPES
from .views import node_route, reply, body


class PreviewParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta, self.title, self.in_title, self.icon = {}, '', False, ''

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'title':
            self.in_title = True
        elif tag == 'meta':
            key = (attrs.get('property') or attrs.get('name') or '').lower()
            self.meta.setdefault(key, attrs.get('content', '')[:2048])
        elif tag == 'link' and 'icon' in attrs.get('rel', '').lower().split():
            self.icon = attrs.get('href', '')[:2048]

    def handle_endtag(self, tag):
        if tag == 'title':
            self.in_title = False

    def handle_data(self, value):
        if self.in_title:
            self.title = (self.title + value)[:300]


def fetcher(max_bytes=2*1024*1024):
    return SafeMediaFetcher(None, max_bytes=max_bytes, timeout=5, total_timeout=12, max_redirects=3)


def preview_image(url):
    try:
        data, mime = fetcher(5*1024*1024)(url)
        if mime.split(';')[0] not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon'):
            return None
        # Store a verified pixel derivative, so a mislabelled HTML/SVG file is never
        # served from the board origin. Metadata cannot choose a storage path.
        from PIL import Image
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 40_000_000:
                return None
            image.thumbnail((1280, 1280))
            output = io.BytesIO()
            image.convert('RGBA').save(output, format='PNG')
        return get_storage().upload_buffer(output.getvalue(), f'canvas/previews/{uuid4()}.png', 'png')
    except Exception:
        return None


def preview(url, data):
    parser = PreviewParser()
    parser.feed(data.decode('utf-8', errors='replace'))
    meta = parser.meta
    result = {'type': 'linkcard', 'url': url,
              'title': (meta.get('og:title') or parser.title or urlsplit(url).hostname or url)[:300],
              'description': (meta.get('og:description') or meta.get('description') or '')[:500],
              'site': (meta.get('og:site_name') or urlsplit(url).hostname or '')[:120]}
    for field, target in [('image', meta.get('og:image')), ('favicon', parser.icon or '/favicon.ico')]:
        if target and (ref := preview_image(urljoin(url, target))):
            result[field] = ref
    return result


def board_actor(request, identifier, permission):
    actor = lookup(request)
    if actor is None:
        raise access.AccessError('UNAUTHENTICATED', 401)
    board = access.board_row(identifier)
    if board is None:
        raise access.AccessError('Board not found.', 404)
    access.require(actor, board, permission)
    return actor


@node_route(['GET'])
def media_detail(request, identifier, media_id):
    try:
        board_actor(request, identifier, access.READ)
        row = BoardMedia.objects.filter(pk=media_id, board_id=identifier).first()
        return reply(request, describe(row)) if row else reply(request, {'error': 'File not found.'}, 404)
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except (ValueError, TypeError, ValidationError):
        return reply(request, {'error': 'Invalid file id.'}, 400)


@node_route(['GET'])
def media_library(request, identifier):
    try:
        actor = board_actor(request, identifier, access.READ)
        # Same team library as existing media, limited in the query to boards the
        # actor can read, so every page is full. Cursor bounds work on large libraries.
        before = request.GET.get('before', '')
        rows = BoardMedia.objects.filter(state='ready', board_id__in=access.readable_boards(actor)).order_by('-created_at', '-id')
        if before:
            cursor = BoardMedia.objects.filter(pk=before).first()
            if not cursor:
                return reply(request, {'error': 'Invalid library cursor.'}, 400)
            rows = rows.filter(Q(created_at__lt=cursor.created_at) | Q(created_at=cursor.created_at, id__lt=cursor.id))
        page = list(rows[:100])
        return reply(request, {'files': [describe(row) for row in page], 'next': str(page[-1].id) if len(page) == 100 else None})
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except (ValueError, TypeError, ValidationError):
        return reply(request, {'error': 'Invalid library cursor.'}, 400)


@node_route(['POST'])
def import_url(request, identifier):
    try:
        actor = board_actor(request, identifier, access.WRITE)
        payload = body(request)
        url = payload.get('url', '')
        if not isinstance(url, str) or len(url) > 2048:
            return reply(request, {'error': 'Enter a public HTTPS URL.'}, 400)
        if not url.startswith('https://'):
            return reply(request, {'error': 'Use a public HTTPS link.'}, 400)
        cache_key = 'canvas-link:' + hashlib.sha256(url.encode()).hexdigest()
        if cached := cache.get(cache_key):
            return reply(request, {'node': cached})
        def limit(mime):
            if mime.split(';')[0].lower() in ('text/html', 'application/xhtml+xml'):
                return 2*1024*1024
            if not re.fullmatch(PURPOSES['canvas'][1], mime.split(';')[0].lower()):
                raise ValueError('This file type is not supported on boards.')
            return 150*1024*1024 if mime.startswith('video/') else LIMITS['canvas']
        with fetcher(LIMITS['canvas']).open_file(url, limit_for=limit) as (stream, mime):
            mime = mime.split(';')[0].lower()
            if mime in ('text/html', 'application/xhtml+xml'):
                node = preview(url, stream.read())
                cache.set(cache_key, node, 3600)
                return reply(request, {'node': node})
            # Imported originals remain private and use the same conversion path
            # as READY upload manifests. Never inline payloads into board JSON.
            if not _sniff(stream.read(128), mime):
                raise ValueError('The file does not match its declared type.')
            stream.seek(0)
            storage = get_storage()
            key = f'canvas-imports/{actor.id}/{uuid4()}'
            storage.upload_stream(stream, key, 'application/octet-stream', 'private, max-age=0')
            try:
                row = register(actor, identifier, key, mime, urlsplit(url).path.rsplit('/', 1)[-1] or 'Imported file')
            except Exception:
                storage.primary.delete(key)
                raise
            if mime not in RASTER_TYPES:
                storage.primary.delete(key)
            return reply(request, describe(row), 200 if row.state == 'ready' else 202)
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except (ValueError, UnsafeMediaURL, OSError, TimeoutError):
        return reply(request, {'error': 'Could not import this public HTTPS link. Check its address, format and size.'}, 400)
