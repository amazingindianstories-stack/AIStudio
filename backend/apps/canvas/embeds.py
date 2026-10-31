"""Board embeds: a closed list of providers whose embed pages may be framed on a board.

A board never frames an arbitrary page. A pasted link or iframe code is turned into the provider's own embed
address (`embed_from_url`, `embed_from_iframe`), and only addresses that match a provider rule pass
`classify`, which is also what the board serializer enforces on save. The frame is sandboxed in the browser, so
a provider page cannot touch the board's origin. Mirrors src/lib/canvas/embeds.js.
"""
import html
import re
from urllib.parse import parse_qs, quote, unquote, urlsplit

MAX_EMBED_SRC = 1024
YOUTUBE_ID = r'[A-Za-z0-9_-]{11}'
SPOTIFY_KINDS = 'track|album|playlist|episode|show|artist'

# (provider, kind, host pattern, path pattern, query required). Patterns are matched in full.
RULES = (
    ('youtube', 'video', r'www\.youtube\.com|www\.youtube-nocookie\.com', rf'/embed/{YOUTUBE_ID}', False),
    ('vimeo', 'video', r'player\.vimeo\.com', r'/video/[0-9]{1,12}', False),
    ('loom', 'video', r'www\.loom\.com', r'/embed/[0-9a-f]{32}', False),
    ('dailymotion', 'video', r'www\.dailymotion\.com', r'/embed/video/[A-Za-z0-9]{3,16}', False),
    ('spotify', 'audio', r'open\.spotify\.com', rf'/embed/(?:{SPOTIFY_KINDS})/[A-Za-z0-9]{{10,40}}', False),
    ('soundcloud', 'audio', r'w\.soundcloud\.com', r'/player/?', True),
    ('figma', 'other', r'www\.figma\.com', r'/embed', True),
    ('drive', 'other', r'drive\.google\.com', r'/file/d/[A-Za-z0-9_-]{10,80}/preview', False),
)
PROVIDER_NAMES = {'youtube': 'YouTube', 'vimeo': 'Vimeo', 'loom': 'Loom', 'dailymotion': 'Dailymotion',
                  'spotify': 'Spotify', 'soundcloud': 'SoundCloud', 'figma': 'Figma', 'drive': 'Google Drive'}
HTTPS_URL = re.compile(r'https://[^\x00-\x20\x7f"\'<>\\]+')
IFRAME_TAG = re.compile(r'<iframe\b([^>]*)>', re.IGNORECASE)
ATTRIBUTE = re.compile(r'([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|\'([^\']*)\')')
MAX_CODE = 4000


def _split(src):
    try:
        parts = urlsplit(src)
        host = (parts.hostname or '').lower()
        port = parts.port
    except ValueError:
        return None
    if parts.scheme != 'https' or not host or parts.username or parts.password or port not in (None, 443) or parts.fragment:
        return None
    return parts, host


def classify(src):
    """`{provider, kind}` when `src` is a framable provider embed address, else None."""
    if not isinstance(src, str) or not 0 < len(src) <= MAX_EMBED_SRC or not HTTPS_URL.fullmatch(src):
        return None
    split = _split(src)
    if split is None:
        return None
    parts, host = split
    for provider, kind, host_pattern, path_pattern, needs_query in RULES:
        if re.fullmatch(host_pattern, host) and re.fullmatch(path_pattern, parts.path):
            if needs_query and not parts.query:
                continue
            return {'provider': provider, 'kind': kind}
    return None


def allowed_embed_src(src):
    return classify(src) is not None


def _query(parts):
    return {key: values[0] for key, values in parse_qs(parts.query).items() if values}


def _result(src):
    info = classify(src)
    return {**info, 'src': src, 'title': PROVIDER_NAMES[info['provider']]} if info else None


def embed_from_url(url):
    """The embed for a page link or an embed address, or None when no provider matches."""
    if not isinstance(url, str):
        return None
    url = url.strip()
    if _result(url):
        return _result(url)
    if not HTTPS_URL.fullmatch(url) or len(url) > 2048:
        return None
    split = _split(url)
    if split is None:
        return None
    parts, host = split
    host = host[4:] if host.startswith('www.') else host
    path, query = parts.path, _query(parts)
    found = None
    if host in ('youtube.com', 'm.youtube.com', 'music.youtube.com'):
        match = re.fullmatch(rf'/(?:shorts|live|embed)/({YOUTUBE_ID})', path)
        found = match[1] if match else query.get('v')
    elif host == 'youtu.be':
        match = re.fullmatch(rf'/({YOUTUBE_ID})', path)
        found = match[1] if match else None
    if found is not None:
        if not re.fullmatch(YOUTUBE_ID, found):
            return None
        start = query.get('t') or query.get('start')
        suffix = f'?start={int(start.rstrip("s"))}' if start and re.fullmatch(r'[0-9]{1,6}s?', start) else ''
        return _result(f'https://www.youtube.com/embed/{found}{suffix}')
    if host in ('vimeo.com', 'player.vimeo.com'):
        hashed = re.fullmatch(r'/([0-9]{1,12})/([0-9a-f]{6,20})', path)
        match = hashed or re.fullmatch(r'/(?:video/)?(?:channels/[a-z0-9_-]+/|groups/[a-z0-9_-]+/videos/)?([0-9]{1,12})', path)
        if match:
            h = hashed[2] if hashed else query.get('h', '')
            suffix = f'?h={h}' if re.fullmatch(r'[0-9a-f]{6,20}', h) else ''
            return _result(f'https://player.vimeo.com/video/{match[1]}{suffix}')
        return None
    if host == 'loom.com':
        match = re.fullmatch(r'/(?:share|embed)/([0-9a-f]{32})', path)
        return _result(f'https://www.loom.com/embed/{match[1]}') if match else None
    if host in ('dailymotion.com', 'dai.ly'):
        match = re.fullmatch(r'/(?:video/)?([A-Za-z0-9]{3,16})', path)
        return _result(f'https://www.dailymotion.com/embed/video/{match[1]}') if match else None
    if host == 'open.spotify.com':
        match = re.fullmatch(rf'/(?:intl-[a-z]{{2,5}}/)?(?:embed/)?({SPOTIFY_KINDS})/([A-Za-z0-9]{{10,40}})', path)
        return _result(f'https://open.spotify.com/embed/{match[1]}/{match[2]}') if match else None
    if host == 'soundcloud.com' and re.fullmatch(r'/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+){0,2}', path):
        return _result(f'https://w.soundcloud.com/player/?url={quote(f"https://soundcloud.com{path}", safe="")}')
    if host == 'figma.com' and re.fullmatch(r'/(?:file|design|proto|board|slides)/[A-Za-z0-9]+(?:/.*)?', path):
        return _result(f'https://www.figma.com/embed?embed_host=veevee&url={quote(url, safe="")}')
    if host == 'drive.google.com':
        match = re.fullmatch(r'/file/d/([A-Za-z0-9_-]{10,80})(?:/.*)?', path)
        return _result(f'https://drive.google.com/file/d/{match[1]}/preview') if match else None
    return None


def embed_from_iframe(code):
    """The embed for pasted iframe code. Only the frame's `src` is read: sizes, scripts and any other markup in
    the pasted code are dropped, and the address must itself be a provider embed address."""
    if not isinstance(code, str) or len(code) > MAX_CODE:
        return None
    tag = IFRAME_TAG.search(code)
    if not tag:
        return None
    attributes = {}
    for name, double, single in ATTRIBUTE.findall(tag[1]):
        attributes.setdefault(name.lower(), double or single)
    src = html.unescape(attributes.get('src', '')).strip()
    if src.startswith('//'):
        src = 'https:' + src
    found = _result(src)
    if found is None:
        return None
    title = html.unescape(attributes.get('title', '')).strip()
    if title:
        found['title'] = title[:200]
    return found


def soundcloud_target(src):
    """The track address inside a SoundCloud player address, for display."""
    split = _split(src) if isinstance(src, str) else None
    return unquote(_query(split[0]).get('url', '')) if split else ''
