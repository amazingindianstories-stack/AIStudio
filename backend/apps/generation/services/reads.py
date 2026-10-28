"""Reading the generation library, shared by the web views and agent tools.

The library is shared: every signed-in user may read every generation, as GET /api/history always has. Search
and counts take the history query parameters (``params``: a QueryDict, or a mapping of names to a value or a list
of values) and page with the ``(created_at, id)`` keyset cursor. Single and batch reads return the same public item
the history list returns.

Agent tools opt in to two extensions the web never sends (``options``): ``names`` also matches the permanent name, and
``subfolders`` widens a folder scope to its subtree (at most ``MAX_SUBTREE_FOLDERS`` folders). Their cursors always
carry the query fingerprint.
"""
from uuid import UUID
from django.db import connection
from django.db.models import BooleanField, Count, F, Q
from django.db.models.expressions import RawSQL
from django.http import QueryDict
from rest_framework.exceptions import ValidationError
from apps.library.filenames import batch_resolve_generation_filenames
from ..history_parameters import decode_cursor, page_limit
from ..library_filters import (apply_library_filters, parse_library_filters, library_options,
    query_fingerprint, decode_library_cursor, encode_library_cursor)
from ..models import Generation
from ..serialization import generation_item
from ..updates import operand_text

JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
# One batch read; a history page is at most 100.
MAX_BATCH = 100
MAX_SUBTREE_FOLDERS = 500           # like apps/library/services/folder_engine.descendants


def query_params(params):
    """``params`` as a QueryDict, the shape the history view receives."""
    if isinstance(params, QueryDict):
        return params
    result = QueryDict(mutable=True)
    for key, value in (params or {}).items():
        for item in (value if isinstance(value, (list, tuple)) else [value]):
            if item is not None:
                result.appendlist(key, str(item))
    return result


def first(params, key):
    values = params.getlist(key)
    return values[0] if values else None


def filters(params):
    project = first(params, 'projectId')
    kind = first(params, 'kind')
    raw = (first(params, 'q') or '').strip(JS_WHITESPACE)
    # JavaScript slice counts UTF-16 units; Node's UTF-8 binding replaces an
    # orphan surrogate at the slice boundary with U+FFFD.
    query = raw.encode('utf-16-le', 'surrogatepass')[:400].decode('utf-16-le', 'replace').strip(JS_WHITESPACE)
    return (None if project == 'none' else project), (kind if kind in ('image', 'video', 'audio') else None), query


def base_query(kind, query, *, names=False):
    rows = Generation.objects.all()
    if kind != 'audio':
        rows = rows.exclude(kind='audio')
    if kind:
        rows = rows.filter(kind=kind)
    if query:
        pattern = '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        # Keep PostgreSQL ILIKE semantics (Django icontains uses UPPER/LIKE).
        match = Q(RawSQL('"generations"."prompt" ILIKE %s', [pattern], output_field=BooleanField()))
        if names:
            match |= Q(RawSQL('"generations"."permanent_name" ILIKE %s', [pattern], output_field=BooleanField()))
        rows = rows.filter(match)
    return rows


def subtree(folder_id):
    """The folder and every folder below it (cycle-safe); refused beyond ``MAX_SUBTREE_FOLDERS`` subfolders."""
    with connection.cursor() as cursor:
        cursor.execute('''WITH RECURSIVE tree(id) AS (
                SELECT id FROM folders WHERE id = %s::uuid
                UNION SELECT f.id FROM folders f JOIN tree ON f.parent_id = tree.id)
            SELECT id FROM tree LIMIT %s''', [str(folder_id), MAX_SUBTREE_FOLDERS + 2])
        ids = [str(row[0]) for row in cursor.fetchall()]
    if len(ids) > MAX_SUBTREE_FOLDERS + 1:
        raise ValidationError({'error': f'This folder has more than {MAX_SUBTREE_FOLDERS} subfolders; choose a smaller folder.'})
    return ids


def grouped(rows):
    result = {'total': 0, 'unsorted': 0, 'byFolder': {}}
    for row in rows.order_by().values('folder_id').annotate(n=Count('*')):
        result['total'] += row['n']
        if row['folder_id'] is None:
            result['unsorted'] += row['n']
        else:
            result['byFolder'][str(row['folder_id'])] = row['n']
    return result


def count_library(params):
    """SQL counts per scope: the project's and the global library's folders, all assets and favorites."""
    project, kind, query = filters(query_params(params))
    rows = base_query(kind, query)
    return {'project': grouped(rows.filter(project_id=project)) if project else {'total': 0, 'unsorted': 0, 'byFolder': {}},
        'globalLibrary': grouped(rows.filter(project_id=None)),
        'allAssets': rows.count(), 'favorites': rows.filter(is_favorite=True).count()}


def location_counts():
    """SQL item counts per ``(project_id, folder_id)`` over the library (audio excluded, as in every scope's default)."""
    return {(row['project_id'], row['folder_id']): row['n']
            for row in base_query(None, '').order_by().values('project_id', 'folder_id').annotate(n=Count('*'))}


def source_history(params, *, search=True, options=None):
    options = options or {}
    project, kind, query = filters(params)
    rows = base_query(kind if search else None, query if search else '', names=options.get('names', False))
    if first(params, 'projectId') == 'none' or project:
        rows = rows.filter(project_id=project)
    folder = first(params, 'folderId')
    if folder == 'none':
        rows = rows.filter(folder_id=None)
    elif folder and options.get('subfolders'):
        rows = rows.filter(folder_id__in=subtree(folder))
    elif folder:
        rows = rows.filter(folder_id=folder)
    favorite = first(params, 'favorite') == '1'
    if favorite:
        rows = rows.filter(is_favorite=True)
    return rows


def count_history(params, *, options=None):
    """The SQL total of a library scope or search with its filters: every matching row, never a loaded page."""
    params = query_params(params)
    return apply_library_filters(source_history(params, options=options), parse_library_filters(params)).count()


def query_history(params, *, options=None):
    """One page of a library scope or search: ``{'items', 'nextCursor'}``, or ``{'options'}`` with ``options=1``.

    ``options`` (agent tools only) is ``{'names': bool, 'subfolders': bool}``; with it, cursors always carry the
    query fingerprint, so a cursor from another query is refused."""
    params = query_params(params)
    if first(params, 'options') == '1':
        return {'options': library_options(source_history(params, search=False))}
    selected_filters = parse_library_filters(params)
    rows = apply_library_filters(source_history(params, options=options), selected_filters)
    favorite = first(params, 'favorite') == '1'
    sort_mode = selected_filters.get('sort', 'starred' if favorite else 'newest')
    sort = 'favorited_at' if sort_mode == 'starred' else 'created_at'
    ascending = sort_mode == 'oldest'
    fingerprint = (query_fingerprint(params, {**selected_filters, 'options': options}) if options is not None
                   else query_fingerprint(params, selected_filters) if selected_filters else None)
    raw_cursor = first(params, 'cursor')
    cursor = (decode_library_cursor(raw_cursor, fingerprint) if raw_cursor and (fingerprint or raw_cursor.startswith('v1:'))
              else decode_cursor(raw_cursor))
    if cursor:
        comparator = '>' if ascending else '<'
        rows = rows.filter(RawSQL(f'("generations"."{sort}", "generations"."id") {comparator} (%s::bigint, %s::uuid)',
            [operand_text(cursor['sort']), cursor['id']], output_field=BooleanField()))
    limit = page_limit(first(params, 'limit'))
    # Match the declared composite indexes. created_at/id cannot be NULL;
    # a favorite cursor comparison also excludes NULL. The first favorite
    # page retains the historical NULL-first behavior for legacy rows.
    ordering = ([F(sort).asc(nulls_last=True), F('id').asc(nulls_last=True)] if ascending else
                [F(sort).desc(nulls_last=True), F('id').desc(nulls_last=True)] if sort != 'favorited_at' or cursor else ['-'+sort, '-id'])
    selected = list(rows.order_by(*ordering)[:limit+1])
    more = len(selected) > limit
    page = selected[:limit]
    names = batch_resolve_generation_filenames([row.id for row in page])
    items = [generation_item(row, names.get(str(row.id), {}).get('filename')) for row in page]
    next_cursor = None
    if more and page:
        last = page[-1]
        value = last.favorited_at if sort == 'favorited_at' and last.favorited_at is not None else last.created_at
        next_cursor = (encode_library_cursor(value, last.id, fingerprint) if fingerprint
                       else f'{operand_text(value)}.{last.id}')
    return {'items':items, 'nextCursor':next_cursor}


def canonical_id(value):
    try:
        return str(UUID(str(value)))
    except ValueError:
        return None


def get_generations(identifiers):
    """Up to MAX_BATCH generations by id: ``items`` in the order asked, each generation once, and ``missing``,
    the ids that are malformed or name no generation."""
    identifiers = list(dict.fromkeys(str(value) for value in identifiers))
    if len(identifiers) > MAX_BATCH:
        raise ValueError(f'At most {MAX_BATCH} generations can be read at once.')
    wanted = {value: canonical_id(value) for value in identifiers}
    rows = {str(row.id): row for row in Generation.objects.filter(pk__in=[value for value in wanted.values() if value])}
    names = batch_resolve_generation_filenames(list(rows))
    items, missing, seen = [], [], set()
    for value in identifiers:
        row = rows.get(wanted[value])
        if row is None:
            missing.append(value)
        elif str(row.id) not in seen:
            seen.add(str(row.id))
            items.append(generation_item(row, names.get(str(row.id), {}).get('filename')))
    return {'items': items, 'missing': missing}


def get_generation(identifier):
    """One generation's public item, or None when the id is malformed or names no generation."""
    items = get_generations([identifier])['items']
    return items[0] if items else None
