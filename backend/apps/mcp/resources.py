"""MCP resources (architecture v2 section 5.5). Every resource has a tool equivalent, so no tool depends on a client
reading resources:

    veevee://models                          list_models
    veevee://generation/{id}                 get_generation (fresh links on every read)
    veevee://generation/{id}/thumbnail       the 512 px WebP thumbnail, or the video poster (binary)
    veevee://generation/{id}/original        get_download_links: {url, expiresAt, filename, mimeType}, never the bytes
    veevee://folder/{id}, veevee://folder/global
                                             list_folders plus search_generations: the folder, its subfolders, counts
                                             and its first 20 items
    veevee://export/{id}                     get_export (owner only; a fresh download link on every read)

Reading needs the veevee.read scope and counts against the per-token call rate, like a read tool.
"""
import base64
import json
import logging
import re

import mcp_types as types
from mcp.shared.exceptions import MCPError

from apps.mcp_auth import controls
from . import catalog, errors, links, results
from .runtime import db
from .shapes import iso
from .tools.exports import export_result, owned as owned_export
from .tools.generations import detail
from .tools.library import folder_tree, search

logger = logging.getLogger('veevee.mcp')
RESOURCE_NOT_FOUND = -32002
REFUSED = -32600
FOLDER_ITEMS = 20
ID = r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'
ROUTES = (('models', re.compile(r'^veevee://models$')),
          ('generation', re.compile(rf'^veevee://generation/{ID}$')),
          ('thumbnail', re.compile(rf'^veevee://generation/{ID}/thumbnail$')),
          ('original', re.compile(rf'^veevee://generation/{ID}/original$')),
          ('folder', re.compile(rf'^veevee://folder/({ID[1:-1]}|global)$')),
          ('export', re.compile(rf'^veevee://export/{ID}$')))
JSON = 'application/json'

RESOURCES = [
    types.Resource(uri='veevee://models', name='models', title='Models you can use', mime_type=JSON,
                   description='The model catalogue, the same as list_models.'),
    types.Resource(uri='veevee://folder/global', name='global-library', title='Global library', mime_type=JSON,
                   description='The global library: its folders with item counts and its first 20 unsorted items.'),
]
TEMPLATES = [
    types.ResourceTemplate(uri_template='veevee://generation/{id}', name='generation', title='Generation', mime_type=JSON,
                           description='One generation, the same as get_generation; reading it signs fresh links.'),
    types.ResourceTemplate(uri_template='veevee://generation/{id}/thumbnail', name='generation-thumbnail',
                           title='Generation thumbnail', mime_type='image/webp',
                           description='A 512 px WebP thumbnail of a finished image, or the poster frame of a video.'),
    types.ResourceTemplate(uri_template='veevee://generation/{id}/original', name='generation-original',
                           title='Generation download link', mime_type=JSON,
                           description='A 5-minute download link for the original file (never the file itself), like '
                                       'get_download_links.'),
    types.ResourceTemplate(uri_template='veevee://folder/{id}', name='folder', title='Folder', mime_type=JSON,
                           description='A folder: its subfolders, item counts and first 20 items, like list_folders and '
                                       'search_generations {folderId}.'),
    types.ResourceTemplate(uri_template='veevee://export/{id}', name='export', title='ZIP export', mime_type=JSON,
                           description='One of your ZIP exports with a fresh 5-minute download link, like get_export.'),
]


def not_found(uri):
    return MCPError(RESOURCE_NOT_FOUND, f'No resource {uri} is visible to you.')


def text(uri, value):
    return types.ReadResourceResult(contents=[types.TextResourceContents(
        uri=uri, mime_type=JSON, text=json.dumps(value, ensure_ascii=False, separators=(',', ':')))])


def generation(identifier):
    found = detail(identifier)
    return found and found[1]


def thumbnail(identifier):
    found = detail(identifier)
    if not found or found[1]['status'] != 'succeeded':
        return None
    return links.preview_image(found[0])


def original(identifier):
    found = detail(identifier)
    if not found or found[1]['status'] != 'succeeded':
        return None
    item = found[0]
    resolved = links.resolve(item, ('original',))
    if not resolved or not resolved['urls'].get('original'):
        return None
    output = results.output_of(item, resolved, variants=('original',))
    return {'url': output['urls']['original'], 'expiresAt': iso(resolved['urlsExpireAt']), 'filename': output['filename'],
            'mimeType': output['mimeType']}


def export(identifier, user_id):
    """The caller's own export, as get_export returns it; None for anyone else's."""
    try:
        return export_result(owned_export(identifier, user_id))
    except errors.ToolError:
        return None


def find(nodes, identifier):
    for node in nodes:
        if node['id'] == identifier:
            return node
        inner = find(node['children'], identifier)
        if inner:
            return inner
    return None


def shallow(node):
    return {**{key: value for key, value in node.items() if key != 'children'}, 'children': [],
            'childrenOmitted': bool(node['children'])}


def folder(identifier, user_id):
    """The folder (or the global library), its direct subfolders with counts and its first 20 items, newest first."""
    tree = folder_tree(None, 20)
    if identifier == 'global':
        scope = tree['global']
        node = {'id': None, 'name': scope['name'], 'path': scope['name'], 'itemCount': scope['unsortedCount'],
                'totalCount': scope['itemCount'], 'children': [shallow(child) for child in scope['folders']]}
        arguments = {'projectId': 'global', 'folderId': 'unsorted'}
    else:
        found = None
        for scope in [tree['global'], *tree['projects']]:
            found = find(scope['folders'], identifier)
            if found:
                break
        if not found:
            return None
        node = {**found, 'children': [shallow(child) for child in found['children']]}
        node.pop('childrenOmitted', None)
        arguments = {'folderId': identifier}
    page = search({**arguments, 'limit': FOLDER_ITEMS}, user_id)
    return {'folder': node, 'items': page['items'], 'total': page['total'],
            'next': results.call('search_generations', {**arguments, 'cursor': page['nextCursor']},
                                 'Lists the rest of this folder.') if page['nextCursor'] else None}


def caller_principal(ctx):
    from .server import caller
    found = caller(ctx)
    if found.disabled:
        raise MCPError(REFUSED, 'Agent access is switched off for this account. Ask a Veevee admin.')
    if not found.principal.has_scope('veevee.read'):
        raise MCPError(REFUSED, errors.scope_missing('veevee.read').message)
    return found


async def list_resources(ctx, params):
    caller_principal(ctx)
    return types.ListResourcesResult(resources=RESOURCES)


async def list_resource_templates(ctx, params):
    caller_principal(ctx)
    return types.ListResourceTemplatesResult(resource_templates=TEMPLATES)


async def read_resource(ctx, params):
    found = caller_principal(ctx)
    uri = str(params.uri)
    try:
        await db(controls.check_rate, found.principal, 'calls')
    except controls.ControlRefusal as refusal:
        raise MCPError(REFUSED, refusal.message) from None
    route, match = next(((name, pattern.match(uri)) for name, pattern in ROUTES if pattern.match(uri)), (None, None))
    logger.info(json.dumps({'event': 'mcp_resource_read', 'request_id': found.request_id,
                            'token_id': str(found.principal.token_id), 'user_id': str(found.principal.user.id),
                            'resource': route}))
    if route == 'models':
        return text(uri, await db(catalog.catalogue))
    if route is None:
        raise not_found(uri)
    identifier = match.group(1).lower()
    if route == 'thumbnail':
        preview = await db(thumbnail, identifier)
        if not preview:
            raise not_found(uri)
        data, mime = preview
        return types.ReadResourceResult(contents=[types.BlobResourceContents(uri=uri, mime_type=mime,
                                                                             blob=base64.b64encode(data).decode())])
    if route in ('folder', 'export'):
        value = await db(folder if route == 'folder' else export, identifier, found.principal.user.id)
    else:
        value = await db({'generation': generation, 'original': original}[route], identifier)
    if value is None:
        raise not_found(uri)
    return text(uri, value)
