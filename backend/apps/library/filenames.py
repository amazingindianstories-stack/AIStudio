"""Current portable generation filenames; naming sequences stay database-owned."""
import hashlib
import math
import re
import unicodedata
from apps.generation.watermark import WHITESPACE

RESERVED = {'CON', 'PRN', 'AUX', 'NUL'} | {f'{prefix}{n}' for prefix in ('COM', 'LPT') for n in range(1, 10)}
EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mp3', 'wav'}
MIME_EXTENSIONS = {'image/jpeg':'jpg', 'image/jpg':'jpg', 'image/png':'png',
    'image/webp':'webp', 'image/gif':'gif', 'video/mp4':'mp4', 'video/webm':'webm',
    'video/quicktime':'mov', 'audio/mpeg':'mp3', 'audio/mp3':'mp3', 'audio/wav':'wav'}


MAX_TOKEN_CHARS = 120


def slugify_token(raw, fallback='folder'):
    """Portable filename token that keeps the folder name's letter case.

    Leading/trailing whitespace (including no-break and zero-width spaces) is
    trimmed, accents are folded to ASCII, control/format characters and every
    run of anything other than letters and digits become one ``_``, and edge
    ``_``/``.`` are dropped so names never end in a space or dot.
    """
    if not isinstance(raw, str):
        return fallback
    text = ''.join(' ' if unicodedata.category(c) in ('Cc', 'Cf', 'Zs', 'Zl', 'Zp') else c
                   for c in unicodedata.normalize('NFKC', raw)).strip(WHITESPACE + ' ')
    if not text:
        return fallback
    folded = re.sub('[\u0300-\u036f]', '', unicodedata.normalize('NFKD', text))
    token = re.sub('[^A-Za-z0-9]+', '_', folded).strip('_.')[:MAX_TOKEN_CHARS].rstrip('_')
    return token or fallback


def resolve_extension(kind='image', url='', media_key='', content_type=''):
    if content_type:
        mime = str(content_type).split(';')[0].strip(WHITESPACE).lower()
        if mime in MIME_EXTENSIONS:
            return MIME_EXTENSIONS[mime]
    candidate = str(media_key or url or '').split('?')[0].split('#')[0]
    match = re.search(r'\.([a-z0-9]{2,5})$', candidate, re.I)
    if match and match[1].lower() in EXTENSIONS:
        return 'jpg' if match[1].lower() == 'jpeg' else match[1].lower()
    return {'video':'mp4', 'image':'png', 'depth':'png', 'audio':'mp3'}.get(kind, 'bin')


def format_serial(sequence):
    from apps.generation.watermark import number_value
    number = number_value(str(sequence)) if sequence is not None else 0
    if not number or math.isnan(number):
        number = 1
    if math.isinf(number):
        return 'Infinity' if number > 0 else '0001'
    return str(max(1, math.floor(number))).zfill(4)


def bound_filename(prefix, serial, extension):
    suffix = f'_{serial}.{extension}'
    available = 255 - len(suffix.encode('utf-8'))
    if len(prefix.encode('utf-8')) <= available:
        return prefix + suffix
    digest = '_' + hashlib.sha256(prefix.encode('utf-8')).hexdigest()[:16]
    remaining = available - len(digest)
    while prefix and len(prefix.encode('utf-8')) > remaining:
        prefix = prefix[:-1]
    return prefix.rstrip('_') + digest + suffix


def resolve_generation_filename(ancestry=None, namespace='global_unsorted', sequence=1,
                                kind='image', url='', media_key='', content_type=''):
    tokens = ['unsorted']
    if namespace.startswith('folder:'):
        tokens = []
        for folder in ancestry or []:
            tokens.append(slugify_token(folder.get('name')))
        if not tokens:
            tokens = ['folder']
    prefix = '_'.join(tokens)
    if prefix.split('.')[0].upper() in RESERVED:
        prefix = '_' + prefix
    return bound_filename(prefix, format_serial(sequence), resolve_extension(kind, url, media_key, content_type))


def batch_resolve_generation_filenames(generation_ids):
    from django.db import connection
    from .models import Folder
    identifiers = list(dict.fromkeys(str(value) for value in generation_ids if value))
    if not identifiers:
        return {}
    # Fetch only naming inputs and keep absent legacy naming records visible.
    with connection.cursor() as cursor:
        cursor.execute('''SELECT g.id,g.kind,g.url,g.project_id,g.folder_id,n.namespace,n.sequence,g.permanent_name
            FROM generations g LEFT JOIN generation_naming n ON n.generation_id=g.id
            WHERE g.id = ANY(%s::uuid[])''', [identifiers])
        generations = cursor.fetchall()
    folders = {}
    pending = {row[4] for row in generations if row[4] and not row[7]}
    while pending:
        rows = list(Folder.objects.filter(id__in=pending).values('id','parent_id','name'))
        pending = set()
        for row in rows:
            if row['id'] not in folders:
                folders[row['id']] = row
                if row['parent_id'] and row['parent_id'] not in folders:
                    pending.add(row['parent_id'])
    result = {}
    for identifier, kind, url, project_id, folder_id, namespace, sequence, permanent_name in generations:
        namespace = namespace or (f'folder:{folder_id}' if folder_id else
                                  f'project_unsorted:{project_id}' if project_id else 'global_unsorted')
        sequence = sequence or 1
        ancestry, visited = [], set()
        current = folders.get(folder_id)
        while current and current['id'] not in visited:
            visited.add(current['id'])
            ancestry.insert(0, current)
            current = folders.get(current['parent_id'])
        identifier = str(identifier)
        result[identifier] = {'generationId':identifier,
            'filename':(permanent_name + '.' + resolve_extension(kind, url)) if permanent_name else resolve_generation_filename(ancestry, namespace, sequence, kind, url),
            'namespace':namespace, 'sequence':sequence,
            'extension':resolve_extension(kind, url)}
    return result
