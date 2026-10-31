"""Format v1 media objects: video, PDF, embed, link card, code block, emoji and icon, and the `link` any object
may carry. Called from serialization.node; mirrors src/lib/canvas/media-nodes.js, and the shared cases in
fixtures/format_v1_media.json hold the two to the same output.

Media is always a reference to a stored file (`/api/media/...`), never a data URL or an address on another site:
an auto-loading address to someone else's server would leak each viewer's IP address. The one exception is an
embed, whose address must match a provider rule in embeds.py.
"""
import math
import re

from . import embeds

TYPES = {'audio', 'video', 'pdf', 'embed', 'linkcard', 'code', 'emoji', 'icon'}
MEDIA_PREFIX = '/api/media/'
MAX_MEDIA_REF = 600
MAX_URL = 2048
MAX_CODE_UNITS = 20000
MAX_AGREED = 200
MAX_USER_ID = 64
# The code block's languages; `text` is plain text. Mirrors CODE_LANGUAGES in media-nodes.js.
CODE_LANGUAGES = ('text', 'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'php',
                  'ruby', 'swift', 'kotlin', 'sql', 'yaml', 'json', 'html', 'css', 'bash', 'mermaid')
ICON_NAME = re.compile(r'[a-z0-9][a-z0-9-]{0,39}')
LINK_URL = re.compile(r'https?://[^\x00-\x20\x7f]+')
UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
NODE_ID_LIMIT = 64


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _units(text):
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def _string(value, fallback, limit=None):
    if not isinstance(value, str):
        return fallback
    # Counted in code points on both sides, so a long title cuts at the same place in the browser.
    return value if limit is None or len(value) <= limit else value[:limit]


def media_ref(value):
    if isinstance(value, str) and value.startswith(MEDIA_PREFIX) and _units(value) <= MAX_MEDIA_REF:
        return value
    return None


def link_url(value):
    """An http(s) address for a link card or an object link; other schemes never get stored."""
    if isinstance(value, str) and _units(value) <= MAX_URL and LINK_URL.fullmatch(value):
        return value
    return None


def link(raw):
    """An object's one link: `{url}` to a website, `{boardId}` to a board, or `{nodeId}` (with an optional
    `boardId`) to an object. Anything else is dropped."""
    if not isinstance(raw, dict):
        return None
    url = link_url(raw.get('url'))
    if url:
        return {'url': url}
    board = raw.get('boardId')
    board = board if isinstance(board, str) and UUID.fullmatch(board) else None
    node_id = raw.get('nodeId')
    if isinstance(node_id, str) and 0 < _units(node_id) <= NODE_ID_LIMIT:
        return {'nodeId': node_id, **({'boardId': board} if board else {})}
    return {'boardId': board} if board else None


def _unique_strings(raw, limit, length):
    seen = {}
    for value in raw if isinstance(raw, list) else []:
        if isinstance(value, str) and value and value not in seen and _units(value) <= length:
            seen[value] = None
            if len(seen) == limit:
                break
    return list(seen)


def coerce(kind, r, result):
    """Add the type's fields to `result` (the shared id, x, y, w, h and type), or return None when the object
    is not valid for the type."""
    if kind in ('audio', 'video'):
        src = media_ref(r.get('src'))
        if not src:
            return None
        result.update(src=src, aspectLocked=r.get('aspectLocked') is not False, title=_string(r.get('title'), '', 200))
        for key in ('naturalW', 'naturalH'):
            if _finite(r.get(key)):
                result[key] = r[key]
        captions = media_ref(r.get('captions'))
        if captions:
            result['captions'] = captions
    elif kind == 'pdf':
        src = media_ref(r.get('src'))
        pages = r.get('pages')
        if not src or type(pages) is not int or not 1 <= pages <= 2000:
            return None
        page = r.get('page')
        result.update(src=src, name=_string(r.get('name'), 'Document', 200), pages=pages,
                      page=page if type(page) is int and 1 <= page <= pages else 1,
                      aspectLocked=r.get('aspectLocked') is not False)
    elif kind == 'embed':
        found = embeds.classify(r.get('src'))
        if not found:
            return None
        result.update(src=r['src'], provider=found['provider'], kind=found['kind'], title=_string(r.get('title'), '', 200))
    elif kind == 'linkcard':
        url = link_url(r.get('url'))
        if not url:
            return None
        result.update(url=url, title=_string(r.get('title'), '', 300), description=_string(r.get('description'), '', 500),
                      site=_string(r.get('site'), '', 120))
        for key in ('image', 'favicon'):
            ref = media_ref(r.get(key))
            if ref:
                result[key] = ref
    elif kind == 'code':
        font = r.get('fontSize')
        result.update(code=_string(r.get('code'), '', MAX_CODE_UNITS),
                      language=r['language'] if r.get('language') in CODE_LANGUAGES else 'text',
                      fontSize=min(64, max(8, font)) if _finite(font) else 14,
                      lineNumbers=r.get('lineNumbers') is not False)
    elif kind == 'emoji':
        emoji = r.get('emoji')
        if not isinstance(emoji, str) or not 0 < _units(emoji) <= 32:
            return None
        result['emoji'] = emoji
        if _finite(r.get('rotation')):
            result['rotation'] = r['rotation'] % 360
        if r.get('style') == 'sticker':
            result['style'] = 'sticker'
        if r.get('interactive') is True:
            result['interactive'] = True
            agreed = _unique_strings(r.get('agreedBy'), MAX_AGREED, MAX_USER_ID)
            if agreed:
                result['agreedBy'] = agreed
    elif kind == 'icon':
        name = r.get('icon')
        if not isinstance(name, str) or not ICON_NAME.fullmatch(name):
            return None
        result.update(icon=name, color=_string(r.get('color'), '#e5e7eb', 32))
    return result
