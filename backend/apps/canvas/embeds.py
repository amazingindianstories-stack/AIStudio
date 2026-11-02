"""Board embeds: a closed list of providers whose embed pages may be framed on a board.

A board never frames an arbitrary page. The browser turns a pasted link or iframe code into the provider's own
embed address (src/lib/canvas/embeds.js), and the board serializer saves an embed only when its address passes
`classify`. The frame is sandboxed in the browser, so a provider page cannot touch the board's origin.
"""
import re
from urllib.parse import urlsplit

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
HTTPS_URL = re.compile(r'https://[^\x00-\x20\x7f"\'<>\\]+')


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

