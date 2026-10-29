"""Canonical object keys. Never interpret a user key as a filesystem path or URL."""
import re
from urllib.parse import unquote, urlsplit


class InvalidMediaKey(ValueError):
    pass


def validate_key(key, *, private=False):
    if not isinstance(key, str) or not key or len(key.encode('utf-8')) > 1024:
        raise InvalidMediaKey('Invalid media key')
    # Repeated decoding rejects encoded traversal even when another layer decodes later.
    probe = key
    for _ in range(5):
        if '\\' in probe or any(ord(c) < 32 or ord(c) == 127 for c in probe):
            raise InvalidMediaKey('Invalid media key')
        if any(part in ('', '.', '..') for part in probe.split('/')):
            raise InvalidMediaKey('Invalid media key')
        decoded = unquote(probe)
        if decoded == probe:
            break
        probe = decoded
    else:
        raise InvalidMediaKey('Invalid media key encoding')
    if not private and is_protected_key(probe):
        raise InvalidMediaKey('Protected media key')
    return key


def is_protected_key(key):
    if not isinstance(key, str):
        return True
    for _ in range(20):
        if re.match(r'^(settings|migrations)/', key, re.I):
            return True
        match = re.fullmatch(r'thumbs/(?:[0-9]+|poster)/(.+)\.webp', key, re.I)
        if not match:
            return False
        key = match[1]
    return True


def is_export_key(key):
    """Recognize private archive namespaces through URL/derivative wrappers.

    Archive I/O is an internal worker/download operation. An archive is never a
    model reference and must not acquire an ordinary shared-media capability.
    """
    if not isinstance(key, str):
        return True
    for _ in range(20):
        decoded = unquote(key)
        if decoded != key:
            key = decoded
            continue
        if re.match(r'^exports/', key, re.I):
            return True
        match = re.fullmatch(r'thumbs/(?:[0-9]+|poster)/(.+)\.webp', key, re.I)
        if not match:
            return False
        key = match[1]
    return True


def media_key_from_ref(ref, cdn_url=''):
    if not isinstance(ref, str) or not ref.strip():
        return None
    clean = ref.split('?')[0].split('#')[0].strip()
    key = None
    if clean.startswith('/api/media/'):
        key = unquote(clean[len('/api/media/'):])
    elif cdn_url and clean.startswith(cdn_url.rstrip('/') + '/'):
        key = unquote(clean[len(cdn_url.rstrip('/')) + 1:])
    elif re.match(r'^https?://', clean, re.I):
        try:
            parsed = urlsplit(clean)
            host = (parsed.hostname or '').lower()
            path = unquote(parsed.path.lstrip('/'))
            if host == 'storage.googleapis.com' or host == 's3.amazonaws.com' or re.fullmatch(r's3[.-][a-z0-9-]+\.amazonaws\.com', host):
                key = path.split('/', 1)[1] if '/' in path else None
            elif host.endswith('.storage.googleapis.com') or re.search(r'\.s3([.-][a-z0-9-]+)?\.amazonaws\.com$', host):
                key = path
            elif path.startswith('api/media/'):
                key = path[len('api/media/'):]
            elif re.match(r'^(generated|assets|thumbs|uploads)/', path):
                key = path
        except ValueError:
            return None
    elif re.match(r'^(generated|assets|thumbs|uploads)/', clean):
        key = clean
    if key:
        try:
            return validate_key(key)
        except InvalidMediaKey:
            return None
    return None
