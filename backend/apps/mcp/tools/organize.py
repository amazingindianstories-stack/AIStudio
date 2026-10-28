"""Organise tools: set_favorite, create_folder, rename_folder, move_folder and move_to_folder (admin only).

They call the web's write services (``apps.generation.history_writes``, ``apps.library.services.folder_engine``), so
folder ids, hierarchy, optimistic versions, serial counters, permanent names and frozen export filenames behave
exactly as on the web. Folder writes go through the shared idempotency receipts when the agent sends an idempotencyKey.
"""
from django.db import transaction

from apps.generation.history_writes import patch_metadata
from apps.generation.models import Generation
from apps.generation.services import reads
from apps.library.models import Folder
from apps.library.services import folder_engine
from apps.library.services.idempotency import OrganizationError
from .. import errors, paid, results
from ..registry import USER_DATA, ToolResult, obj, register
from ..runtime import db
from ..shapes import iso

STRING, INTEGER, BOOLEAN = {'type': 'string'}, {'type': 'integer'}, {'type': 'boolean'}
GLOBAL = 'global'
MAX_MOVE = reads.MAX_BATCH
COLORS = sorted(folder_engine.COLORS)
LIST_FOLDERS = results.call('list_folders', {}, 'Shows every folder with its id and current version.')
NOT_FOUND_CODES = ('FOLDER_NOT_FOUND', 'DESTINATION_NOT_FOUND', 'PROJECT_NOT_FOUND')
CHANGED_CODES = ('VERSION_CONFLICT', 'SCOPE_MISMATCH')
IDEMPOTENCY_KEY = {**paid.PAID_CONTROLS['idempotencyKey'],
                   'description': 'Retrying with the same key returns the first result instead of acting twice. '
                                  'Without a key every call acts again.'}
EXPECTED_VERSION = {'type': 'integer', 'minimum': 1,
                    'description': 'The folder version from list_folders; the call is refused if the folder changed since.'}
FOLDER_SCHEMA = results.obj({
    'id': STRING, 'name': STRING, 'color': results.nullable(STRING), 'projectId': results.nullable(STRING),
    'parentId': results.nullable(STRING), 'path': STRING, 'version': INTEGER, 'createdAt': STRING, 'updatedAt': STRING,
    'resourceUri': STRING})
FOLDER_RESULT = results.obj({'folder': FOLDER_SCHEMA})
MOVE_FOLDER_RESULT = results.obj({'folder': FOLDER_SCHEMA, 'subtreeFolderCount': INTEGER, 'scopeChanged': BOOLEAN})


def refused(error, tool):
    """A folder engine refusal as a tool error; the web's messages pass through verbatim."""
    message = str(error)
    if error.code in paid.CONFLICTS:
        return errors.ToolError(errors.IDEMPOTENCY_CONFLICT, 'This idempotencyKey was already used with different '
                                                             'arguments. Use a new key.')
    if error.code == 'GENERATION_NOT_FOUND':
        return errors.ToolError(errors.NOT_FOUND, f'{message} Use search_generations to find it.')
    if error.code in NOT_FOUND_CODES:
        return errors.ToolError(errors.NOT_FOUND, f'{message} Call list_folders for the current folders.', next=LIST_FOLDERS)
    if error.code in CHANGED_CODES:
        return errors.ToolError(errors.VERSION_CONFLICT, f'{message} Call list_folders for its current version, check '
                                                         f'the change still makes sense, then call {tool} again.',
                                next=LIST_FOLDERS)
    if error.code == 'FORBIDDEN':
        return errors.ToolError(errors.FORBIDDEN, message)
    return errors.ToolError(errors.INVALID_INPUT, message)


def folder_of(identifier):
    """The ``Folder`` object as it is now (a replayed receipt may be older), with its path from the library root."""
    folder = Folder.objects.filter(pk=identifier).first()
    if folder is None:
        raise errors.ToolError(errors.NOT_FOUND, 'The folder this call made or changed has since been deleted. Call '
                                                 'list_folders; to repeat the change, pass a new idempotencyKey.',
                               next=LIST_FOLDERS)
    found = folder_engine.folder_json(folder)
    return {'id': found['id'], 'name': found['name'], 'color': found['color'], 'projectId': found['projectId'],
            'parentId': found['parentId'], 'path': results.folder_paths([found['id']])[found['id']],
            'version': found['version'], 'createdAt': iso(found['createdAt']), 'updatedAt': iso(found['updatedAt']),
            'resourceUri': f"veevee://folder/{found['id']}"}


def place(destination):
    """``(kind, id)`` for a destination argument: ``global``, ``{projectId}`` or ``{folderId}``."""
    if destination == GLOBAL:
        return GLOBAL, None
    if 'folderId' in destination:
        return 'folder', destination['folderId'].lower()
    return 'project', destination['projectId'].lower()


def organise(call, tool, operation):
    """Run a folder engine write; the caller's idempotencyKey, when sent, makes a retry replay the first result."""
    try:
        return operation(actor_id=str(call.principal.user.id), idempotency_key=call.arguments.get('idempotencyKey'))
    except OrganizationError as error:
        raise refused(error, tool) from None


def destination_schema(where):
    return {'anyOf': [{'const': GLOBAL, 'description': f'The global library {where}.'},
                      obj({'projectId': {**results.UUID, 'description': f'A project id from list_folders ({where}).'}},
                          ('projectId',)),
                      obj({'folderId': {**results.UUID, 'description': 'A folder id from list_folders.'}}, ('folderId',))]}


def favorite(identifier, value):
    """Set the favourite flag with the web's write; a call that changes nothing keeps the original star time."""
    with transaction.atomic():
        current = Generation.objects.select_for_update().filter(pk=identifier).values_list('is_favorite', flat=True).first()
        if current is None:
            raise errors.ToolError(errors.NOT_FOUND, f'No generation {identifier} is visible to you. '
                                                     'Use search_generations to find it.')
        if current != value:
            patch_metadata({'id': identifier, 'isFavorite': value})
    return {'generation': results.generations([reads.get_generation(identifier)], detail='summary')[0],
            'changed': current != value}


@register(
    name='set_favorite', title='Set a favourite', scope='veevee.organize', read_only=False,
    description=('Mark or unmark a generation as a favourite.\n'
                 'Favourites are shared by everyone in the studio library, as on the web. Setting the value it already '
                 'has changes nothing (changed is false). ' + USER_DATA),
    input_schema=obj({'id': {**results.UUID, 'description': 'The generation id.'},
                      'favorite': {'type': 'boolean', 'description': 'true to mark it, false to unmark it.'}},
                     ('id', 'favorite')),
    output_schema=results.obj({'generation': results.GENERATION_SCHEMA, 'changed': BOOLEAN}))
async def set_favorite(call):
    identifier, value = call.arguments['id'].lower(), call.arguments['favorite']
    found = await db(favorite, identifier, value)
    call.record['generationId'] = identifier
    name = found['generation']['name'] or identifier
    state = 'a favourite' if value else 'not a favourite'
    return ToolResult(found, f'{name} is now {state}.' if found['changed'] else f'{name} was already {state}.')


def create(call):
    arguments = call.arguments
    kind, identifier = place(arguments.get('in', GLOBAL))
    found = organise(call, 'create_folder', lambda **common: folder_engine.create_folder(
        name=arguments['name'], color=arguments.get('color'), project_id=identifier if kind == 'project' else None,
        parent_id=identifier if kind == 'folder' else None, **common))
    return {'folder': folder_of(found['id'])}


@register(
    name='create_folder', title='Create a folder', scope='veevee.organize', read_only=False,
    description=('Create a folder in a project or the global library.\n'
                 'in is "global" (the default), {projectId} for a top-level folder in a project, or {folderId} for a '
                 'subfolder. Names are unique among siblings (ignoring case) and at most 100 characters. Retrying with '
                 'the same idempotencyKey returns the same folder. ' + USER_DATA),
    input_schema=obj({'name': {'type': 'string', 'minLength': 1, 'maxLength': 200, 'description': 'The folder name.'},
                      'in': {**destination_schema('top level'), 'default': GLOBAL},
                      'color': {'enum': COLORS, 'description': 'Optional folder colour.'},
                      'idempotencyKey': IDEMPOTENCY_KEY}, ('name',)),
    output_schema=FOLDER_RESULT)
async def create_folder(call):
    found = await db(create, call)
    call.record['folderId'] = found['folder']['id']
    return ToolResult(found, f"Created the folder {found['folder']['path']}.")


def rename(call):
    arguments = call.arguments
    identifier = arguments['folderId'].lower()
    found = organise(call, 'rename_folder', lambda **common: folder_engine.rename_folder(
        folder_id=identifier, name=arguments['name'], expected_version=arguments['expectedVersion'], **common))
    return {'folder': folder_of(found['id'])}


@register(
    name='rename_folder', title='Rename a folder', scope='veevee.organize', read_only=False,
    description=('Rename a folder. Pass the version list_folders showed as expectedVersion.\n'
                 'The names and download filenames of items already in the folder do not change. If the folder changed '
                 'since you read it the call is refused with VERSION_CONFLICT. ' + USER_DATA),
    input_schema=obj({'folderId': {**results.UUID, 'description': 'A folder id from list_folders.'},
                      'name': {'type': 'string', 'minLength': 1, 'maxLength': 200, 'description': 'The new name.'},
                      'expectedVersion': EXPECTED_VERSION, 'idempotencyKey': IDEMPOTENCY_KEY},
                     ('folderId', 'name', 'expectedVersion')),
    output_schema=FOLDER_RESULT)
async def rename_folder(call):
    found = await db(rename, call)
    call.record['folderId'] = found['folder']['id']
    return ToolResult(found, f"Renamed the folder to {found['folder']['path']}.")


def move(call):
    arguments = call.arguments
    identifier = arguments['folderId'].lower()
    kind, target = place(arguments['destination'])
    destination = ({'type': 'global_root'} if kind == GLOBAL else {'type': 'project_root', 'projectId': target}
                   if kind == 'project' else {'type': 'folder', 'folderId': target})
    found = organise(call, 'move_folder', lambda **common: folder_engine.move_folder(
        folder_id=identifier, destination=destination, expected_version=arguments['expectedVersion'], **common))
    return {**found, 'folder': folder_of(found['folder']['id'])}


@register(
    name='move_folder', title='Move a folder', scope='veevee.organize', read_only=False,
    description=('Move a folder, with its subfolders and items, to another place. Pass the version list_folders showed '
                 'as expectedVersion.\n'
                 'destination is "global" (top level of the global library), {projectId} (top level of a project) or '
                 '{folderId} (inside another folder). Item names and download filenames do not change. '
                 'scopeChanged says whether it moved between projects. ' + USER_DATA),
    input_schema=obj({'folderId': {**results.UUID, 'description': 'The folder to move.'},
                      'destination': destination_schema('top level'),
                      'expectedVersion': EXPECTED_VERSION, 'idempotencyKey': IDEMPOTENCY_KEY},
                     ('folderId', 'destination', 'expectedVersion')),
    output_schema=MOVE_FOLDER_RESULT)
async def move_folder(call):
    found = await db(move, call)
    call.record['folderId'] = found['folder']['id']
    count = found['subtreeFolderCount'] - 1
    inside = f' with {count} subfolder{"" if count == 1 else "s"}' if count else ''
    return ToolResult(found, f"Moved the folder to {found['folder']['path']}{inside}.")


def move_items(call):
    arguments = call.arguments
    ids = list(dict.fromkeys(identifier.lower() for identifier in arguments['ids']))
    kind, target = place(arguments['destination'])
    destination = ({'type': 'global_unsorted'} if kind == GLOBAL else {'type': 'project_unsorted', 'projectId': target}
                   if kind == 'project' else {'type': 'folder', 'folderId': target})
    found = organise(call, 'move_to_folder', lambda **common: folder_engine.move_generations(
        ids=ids, destination=destination, **common))
    moved = reads.get_generations(found['updatedIds'])['items']
    location = {'projectId': found['projectId'], 'folderId': found['folderId'],
                'folderPath': results.folder_paths([found['folderId']]).get(found['folderId']) if found['folderId'] else None}
    return {'movedCount': found['movedCount'], 'location': location,
            'items': [{'id': item['id'], 'name': item['filename'].rsplit('.', 1)[0] if item.get('filename') else None}
                      for item in moved]}


@register(
    name='move_to_folder', title='Move generations', scope='veevee.organize', read_only=False, admin_only=True,
    description=('(admin only, as on the web) Move generations to a folder.\n'
                 f'Pass up to {MAX_MOVE} ids. destination is {{folderId}}, {{projectId}} (the project, in no folder) or '
                 '"global" (the global library, in no folder). Items that already have a permanent name keep it; others '
                 'get the next number in their new folder, so items lists the names after the move. ' + USER_DATA),
    input_schema=obj({'ids': {'type': 'array', 'items': results.UUID, 'minItems': 1, 'maxItems': MAX_MOVE,
                              'description': 'Generation ids.'},
                      'destination': destination_schema('in no folder'), 'idempotencyKey': IDEMPOTENCY_KEY},
                     ('ids', 'destination')),
    output_schema=results.obj({
        'movedCount': INTEGER,
        'location': results.obj({'projectId': results.nullable(STRING), 'folderId': results.nullable(STRING),
                                 'folderPath': results.nullable(STRING)}),
        'items': {'type': 'array', 'items': results.obj({'id': STRING, 'name': results.nullable(STRING)})}}))
async def move_to_folder(call):
    found = await db(move_items, call)
    call.record['movedCount'] = found['movedCount']
    if found['location']['folderId']:
        call.record['folderId'] = found['location']['folderId']
    where = found['location']['folderPath'] or ('the project' if found['location']['projectId'] else 'the global library')
    return ToolResult(found, f"Moved {found['movedCount']} generation{'' if found['movedCount'] == 1 else 's'} to {where}.")
