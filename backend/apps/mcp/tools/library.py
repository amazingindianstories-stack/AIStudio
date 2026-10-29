"""Library reads: search_generations, get_download_links and list_folders.

They use the web's shared reads (``apps.generation.services.reads``, ``apps.library.services.folder_reads``): the same
shared library, ``(created_at, id)`` keyset cursors and SQL totals and counts, never the length of a loaded page.
"""
from datetime import datetime, timezone

from rest_framework.exceptions import ValidationError

from apps.generation.services import reads
from apps.library.services import folder_reads
from .. import errors, links, results
from ..registry import URL_EXPIRY, USER_DATA, ToolResult, obj, register
from ..runtime import db

STRING, INTEGER, BOOLEAN = {'type': 'string'}, {'type': 'integer'}, {'type': 'boolean'}
UUID = results.UUID
MAX_LINKS = 50
GLOBAL = 'global'
SORTS = {'newest': 'newest', 'oldest': 'oldest', 'favorited': 'starred'}
ERROR_SCHEMA = results.obj({'code': STRING, 'message': STRING})


def refused(error):
    """A shared-read ``ValidationError`` as INVALID_INPUT, keeping its message."""
    detail = error.detail
    message = detail.get('error') if isinstance(detail, dict) else None
    return errors.ToolError(errors.INVALID_INPUT, f"{message or 'Invalid search.'} See the search_generations input schema.")


def epoch_ms(name, value):
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        raise errors.ToolError(errors.INVALID_INPUT, f'{name}: {value!r} is not an ISO-8601 time such as 2026-10-31T09:00:00Z.') from None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(moment.timestamp() * 1000)


def history_params(arguments, user_id):
    """The history query parameters (``/api/history``) for a search_generations call."""
    params = {'limit': arguments.get('limit', 20)}
    text = arguments.get('text')
    if text:
        params['q'] = text
    kind = arguments.get('kind')
    if kind == 'depth':
        params['type'] = ['depth']
    elif kind:
        params['kind'] = kind
    project, folder = arguments.get('projectId'), arguments.get('folderId')
    if project:
        params['projectId'] = 'none' if project == GLOBAL else project
    if folder:
        params['folderId'] = 'none' if folder == 'unsorted' else folder
    if arguments.get('favorite'):
        params['favorite'] = '1'
    for name, key in (('model', 'model'), ('status', 'status'), ('aspectRatio', 'aspect'), ('stage', 'stage')):
        value = arguments.get(name)
        if value:
            params[key] = value if isinstance(value, list) else [value]
    if arguments.get('resolution'):
        params['resolution'] = [f"{kind}:{arguments['resolution']}" for kind in ('image', 'video', 'depth')]
    creator = arguments.get('createdBy')
    if creator:
        params['creator'] = [str(user_id) if creator == 'me' else creator]
    for name, key in (('createdAfter', 'createdFrom'), ('createdBefore', 'createdBefore')):
        if arguments.get(name):
            params[key] = str(epoch_ms(name, arguments[name]))
    sort = arguments.get('sort', 'newest')
    if sort == 'favorited' and not arguments.get('favorite'):
        raise errors.ToolError(errors.INVALID_INPUT, "sort 'favorited' needs favorite: true.")
    if sort != 'newest' or arguments.get('favorite'):
        params['sort'] = SORTS[sort]
    if arguments.get('cursor'):
        params['cursor'] = arguments['cursor']
    return params


def search(arguments, user_id):
    params = history_params(arguments, user_id)
    options = {'names': True, 'subfolders': bool(arguments.get('includeSubfolders'))}
    try:
        page = reads.query_history(params, options=options)
        total = reads.count_history(params, options=options)
    except ValidationError as error:
        raise refused(error) from None
    return {'items': results.generations(page['items'], detail='summary'), 'nextCursor': page['nextCursor'], 'total': total}


SEARCH_INPUT = obj({
    'text': {'type': 'string', 'maxLength': 200, 'description': 'Words in the prompt or the name (e.g. SHOT_014).'},
    'kind': {'enum': ['image', 'video', 'audio', 'depth'], 'description': 'Audio is listed only when asked for.'},
    'model': {'type': 'array', 'items': {'type': 'string', 'minLength': 1, 'maxLength': 200}, 'maxItems': 50,
              'description': 'Model ids or names from list_models.'},
    'status': {'type': 'array', 'items': {'enum': ['ready', 'creating', 'failed']}, 'maxItems': 3},
    'projectId': {'anyOf': [UUID, {'const': GLOBAL}], 'description': 'A project id, or "global" for the global library.'},
    'folderId': {'anyOf': [UUID, {'const': 'unsorted'}], 'description': 'A folder id, or "unsorted" for items in no folder.'},
    'includeSubfolders': {'type': 'boolean', 'default': False, 'description': 'With folderId, also search its subfolders.'},
    'favorite': {'const': True, 'description': 'Only favourites.'},
    'createdBy': {'anyOf': [{'const': 'me'}, UUID], 'description': '"me" or a user id.'},
    'createdAfter': {'type': 'string', 'maxLength': 40, 'description': 'ISO-8601 time, inclusive.'},
    'createdBefore': {'type': 'string', 'maxLength': 40, 'description': 'ISO-8601 time, exclusive.'},
    'resolution': {'type': 'string', 'minLength': 1, 'maxLength': 40, 'description': 'e.g. 2K or 1080p.'},
    'aspectRatio': {'type': 'string', 'minLength': 1, 'maxLength': 200, 'description': 'e.g. 16:9.'},
    'stage': {'enum': ['draft', 'final'], 'description': 'Seedance 2.5 drafts or finals (videos only).'},
    'sort': {'enum': list(SORTS), 'default': 'newest', 'description': '"favorited" (most recently starred) needs favorite: true.'},
    'cursor': {'type': 'string', 'maxLength': 1024, 'description': 'nextCursor from the previous page of the same search.'},
    'limit': {'type': 'integer', 'minimum': 1, 'maximum': 50, 'default': 20},
})
SEARCH_OUTPUT = results.obj({'items': {'type': 'array', 'items': results.GENERATION_SCHEMA},
                             'nextCursor': results.nullable(STRING), 'total': INTEGER})


@register(
    name='search_generations', title='Search the library', scope='veevee.read', read_only=True,
    description=('Find generations in the library by text, folder, model, type, status, date or favourite. Newest first, '
                 'paged with a cursor.\n'
                 'text matches prompts and names. total counts every match, not just this page; pass nextCursor back '
                 'with the same filters for the next page. Items are summaries with a thumbnail link only: use '
                 'get_generation or get_download_links for full links. ' + URL_EXPIRY + ' ' + USER_DATA),
    input_schema=SEARCH_INPUT, output_schema=SEARCH_OUTPUT)
async def search_generations(call):
    found = await db(search, call.arguments, call.principal.user.id)
    shown = len(found['items'])
    more = ' Pass nextCursor for more.' if found['nextCursor'] else ''
    return ToolResult(found, f"{found['total']} generation{'' if found['total'] == 1 else 's'} match; showing {shown}.{more}")


def item_error(code, message):
    return {'code': code, 'message': message}


def download_links(ids, variants):
    wanted = list(dict.fromkeys(identifier.lower() for identifier in ids))
    found = {item['id']: item for item in reads.get_generations(wanted)['items']}
    ready = [found[identifier] for identifier in wanted
             if identifier in found and found[identifier]['status'] == 'succeeded' and found[identifier].get('url')]
    resolved = dict(zip([item['id'] for item in ready], links.resolve_many(ready, variants, measure='original' in variants)))
    entries = []
    for identifier in wanted:
        item = found.get(identifier)
        if item is None:
            entries.append({'id': identifier, 'error': item_error(errors.NOT_FOUND, f'No generation {identifier} is visible to you.')})
        elif item['status'] != 'succeeded':
            entries.append({'id': identifier, 'error': item_error('NO_OUTPUT', f"This generation is {item['status']}, so it has no file yet."
                                                                 if item['status'] in ('queued', 'running', 'pending')
                                                                 else f"This generation {item['status']} and has no file.")})
        elif resolved.get(identifier) is None:
            entries.append({'id': identifier, 'error': item_error('NO_OUTPUT', 'This generation has no stored file you can download.')})
        else:
            entries.append({'id': identifier, 'outputs': [results.output_of(item, resolved[identifier], variants=variants)]})
    return {'items': entries}


LINKS_OUTPUT = results.obj({'items': {'type': 'array', 'items': {'anyOf': [
    results.obj({'id': STRING, 'outputs': {'type': 'array', 'items': results.OUTPUT_SCHEMA}}),
    results.obj({'id': STRING, 'error': ERROR_SCHEMA})]}}})


@register(
    name='get_download_links', title='Get download links', scope='veevee.read', read_only=True,
    description=('Get fresh download links for up to 50 generations at once (original file, preview, thumbnail or poster). '
                 'Links expire, so call again rather than storing them.\n'
                 'original is the native file (a MOV stays a MOV) as a 5-minute download with its library filename; '
                 'preview, thumbnail and poster last about 14 minutes. An id that is missing or not finished gets an '
                 'error entry instead of failing the call. ' + URL_EXPIRY),
    input_schema=obj({'ids': {'type': 'array', 'items': UUID, 'minItems': 1, 'maxItems': MAX_LINKS,
                              'description': 'Generation ids.'},
                      'variants': {'type': 'array', 'items': {'enum': list(results.FULL_VARIANTS)}, 'minItems': 1,
                                   'default': ['original', 'thumbnail'], 'uniqueItems': True}}, ('ids',)),
    output_schema=LINKS_OUTPUT)
async def get_download_links(call):
    variants = [variant for variant in results.FULL_VARIANTS if variant in call.arguments.get('variants', ['original', 'thumbnail'])]
    found = await db(download_links, call.arguments['ids'], variants)
    ready = sum('outputs' in entry for entry in found['items'])
    return ToolResult(found, f"Fresh links for {ready} of {len(found['items'])} generation{'' if len(found['items']) == 1 else 's'}.")


def folder_tree(project_filter, depth):
    """The folder tree with SQL item counts per folder, the global library and each project (read-only)."""
    tree = folder_reads.tree()
    counts = reads.location_counts()
    by_folder = {}
    for (_, folder), count in counts.items():
        if folder is not None:
            by_folder[str(folder)] = by_folder.get(str(folder), 0) + count

    def node(folder, path, level):
        here = f"{path}/{folder['name']}" if path else folder['name']
        children = [node(child, here, level + 1) for child in folder['children']]
        found = {'id': folder['id'], 'name': folder['name'], 'color': folder['color'], 'path': here,
                 'version': folder['version'], 'itemCount': by_folder.get(folder['id'], 0),
                 'totalCount': by_folder.get(folder['id'], 0) + sum(child['totalCount'] for child in children),
                 'children': children if level < depth else [], 'childrenOmitted': bool(children) and level >= depth}
        return found

    def scope(project_id, folders):
        key = None if project_id is None else project_id
        total = sum(count for (project, _), count in counts.items() if (str(project) if project else None) == key)
        unsorted = sum(count for (project, folder), count in counts.items()
                       if folder is None and (str(project) if project else None) == key)
        return {'itemCount': total, 'unsortedCount': unsorted, 'folders': [node(folder, '', 1) for folder in folders]}

    result = {'global': None, 'projects': []}
    if project_filter in (None, GLOBAL):
        result['global'] = {'name': 'Global library', **scope(None, tree['globalFolders'])}
    for project in tree['projects']:
        if project_filter in (None, project['id']):
            result['projects'].append({'id': project['id'], 'name': project['name'], 'brief': project['brief'],
                                       **scope(project['id'], project['folders'])})
    if project_filter not in (None, GLOBAL) and not result['projects']:
        raise errors.ToolError(errors.NOT_FOUND, f'No project {project_filter} is visible to you. Call list_folders with no arguments.')
    return result


FOLDER_NODE = {'$ref': '#/$defs/folder'}
FOLDER_DEFS = {'folder': results.obj({
    'id': STRING, 'name': STRING, 'color': results.nullable(STRING), 'path': STRING, 'version': INTEGER, 'itemCount': INTEGER,
    'totalCount': INTEGER, 'children': {'type': 'array', 'items': FOLDER_NODE}, 'childrenOmitted': BOOLEAN})}
SCOPE = {'itemCount': INTEGER, 'unsortedCount': INTEGER, 'folders': {'type': 'array', 'items': FOLDER_NODE}}
FOLDERS_OUTPUT = {**results.obj({
    'global': results.nullable(results.obj({'name': STRING, **SCOPE})),
    'projects': {'type': 'array', 'items': results.obj({'id': STRING, 'name': STRING, 'brief': results.nullable(STRING), **SCOPE})},
}), '$defs': FOLDER_DEFS}


@register(
    name='list_folders', title='List folders', scope='veevee.read', read_only=True,
    description=('Show the folder tree (projects, the global library and their folders) with item counts.\n'
                 'itemCount is what sits directly in a folder, totalCount includes its subfolders, and unsortedCount is '
                 'what sits in no folder; counts leave out audio, like search_generations without kind. Use a folder id '
                 'with search_generations {folderId} or export_zip, and its version as expectedVersion in rename_folder '
                 'or move_folder. ' + USER_DATA),
    input_schema=obj({'projectId': {'anyOf': [UUID, {'const': GLOBAL}],
                                    'description': 'Only this project, or "global" for the global library.'},
                      'depth': {'type': 'integer', 'minimum': 1, 'maximum': 20, 'default': 20,
                                'description': 'Folder levels to include.'}}),
    output_schema=FOLDERS_OUTPUT)
async def list_folders(call):
    project = call.arguments.get('projectId')
    found = await db(folder_tree, project.lower() if project and project != GLOBAL else project, call.arguments.get('depth', 20))

    def count(folders):
        return sum(1 + count(folder['children']) for folder in folders)
    folders = count((found['global'] or {}).get('folders', [])) + sum(count(project['folders']) for project in found['projects'])
    return ToolResult(found, f"{len(found['projects'])} project{'' if len(found['projects']) == 1 else 's'} and "
                             f"{folders} folder{'' if folders == 1 else 's'} shown.")
