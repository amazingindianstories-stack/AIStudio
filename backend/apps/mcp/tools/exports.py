"""export_zip and get_export: owner-only ZIP archives through the web's export services (``apps.exports.services``).

export_zip creates the export, appends the selection in chunks of 500 and finalizes it in one transaction behind a
shared idempotency receipt, so a retried call returns the same export. The export worker builds the archive from the
frozen manifest, so filenames match the web ZIP exactly. Both tools hold like the generate tools, on the export row.
"""
from django.conf import settings
from django.db.models import Q
from rest_framework.exceptions import ValidationError

from apps.exports import services
from apps.exports.models import MediaExport
from apps.generation.services import reads
from apps.library.models import Folder
from apps.library.services import idempotency
from apps.library.services.idempotency import now_ms
from apps.media.storage import get_storage
from apps.mcp_auth import policy
from .. import errors, hold, paid, results
from ..registry import USER_DATA, ToolResult, obj, register
from ..runtime import db
from ..shapes import iso
from .generations import WAIT_SECONDS

MAX_IDS = 5000
OPERATION = 'mcp.export_zip'
TERMINAL = ('ready', 'failed', 'draft')
LINK_SECONDS = 300
EXPORTABLE = ('image', 'video', 'depth')
STRING, INTEGER = {'type': 'string'}, {'type': 'integer'}
BUSY_NOTE = (f'This connection already has {policy.HOLDS_PER_TOKEN} calls waiting, so this one returned at once. '
             'Call get_export with wait=true once one of them returns.')
LINK_RULE = ('download.expiresAt is when the download link stops working (5 minutes after this call, or sooner if the '
             'archive expires first); export.expiresAt is when the archive itself is deleted (7 days). Call get_export '
             'for a fresh link rather than storing it.')
EXPORT_SCHEMA = results.obj({
    'id': STRING, 'status': {'enum': ['draft', 'queued', 'running', 'ready', 'failed', 'expired']},
    'totalItems': INTEGER, 'processedItems': INTEGER,
    'skipped': {'type': 'array', 'items': results.obj({'id': STRING, 'reason': {'enum': ['not_found', 'not_downloadable']}})},
    'download': results.nullable(results.obj({
        'url': STRING, 'expiresAt': {**STRING, 'description': 'When this download link stops working (at most 5 minutes).'},
        'filename': STRING, 'bytes': INTEGER})),
    'expiresAt': results.nullable({**STRING, 'description': 'When the archive itself is deleted.'}), 'error': results.nullable(STRING), 'createdAt': STRING, 'resourceUri': STRING})
EXPORT_RESULT = results.obj({
    'outcome': {'enum': ['completed', 'running', 'failed', 'expired']}, 'export': EXPORT_SCHEMA,
    'next': results.nullable(results.NEXT_SCHEMA), 'note': STRING}, ('outcome', 'export', 'next'))
OUTCOMES = {'queued': 'running', 'running': 'running', 'draft': 'failed', 'ready': 'completed', 'failed': 'failed',
            'expired': 'expired'}


def resource_uri(identifier):
    return f'veevee://export/{identifier}'


def not_found(identifier):
    return errors.ToolError(errors.NOT_FOUND, f'No export {identifier} of yours exists. Exports are visible only to the '
                                              'person who made them; make a new one with export_zip.')


def link(job):
    """``(url, expiresAt ms)`` for a ready archive: a 5-minute signed download, or the web's signed-in download route
    on storage that cannot sign one (local development). Either way the link is promised for 5 minutes from before
    it was signed, never past the archive's own expiry."""
    expires = min(now_ms() + LINK_SECONDS * 1000, job.expires_at)
    signed = get_storage().signed_export_download_url(job.output_key, services.archive_filename(job))
    return signed or f"{settings.PUBLIC_APP_URL.rstrip('/')}/api/history/exports/{job.id}/download", expires


def export_of(job, skipped=()):
    """The ``Export`` object for one of the caller's exports, with a fresh download link when it is ready."""
    expired = job.status == 'ready' and (not job.expires_at or job.expires_at <= now_ms())
    status = 'expired' if expired else job.status
    download, error = None, None
    if status == 'ready' and job.output_key:
        try:
            url, expires = link(job)
            download = {'url': url, 'expiresAt': iso(expires), 'filename': services.archive_filename(job),
                        'bytes': job.output_bytes or 0}
        except Exception:
            error = 'The download link could not be signed right now. Call get_export again in a minute.'
    elif status == 'failed':
        error = 'The export failed. Run export_zip again to make a new one.'
    elif status == 'expired':
        error = 'This archive has expired. Run export_zip again to make a new one.'
    elif status == 'draft':
        error = 'This export was started in the web app and never queued. Finish it there, or run export_zip.'
    return {'id': str(job.id), 'status': status, 'totalItems': job.total_items, 'processedItems': job.processed_items,
            'skipped': list(skipped), 'download': download, 'expiresAt': iso(job.expires_at), 'error': error,
            'createdAt': iso(job.created_at), 'resourceUri': resource_uri(job.id)}


def export_result(job, skipped=(), note=None):
    export = export_of(job, skipped)
    outcome = OUTCOMES[export['status']]
    following = (results.call('get_export', {'id': export['id'], 'wait': True},
                              'Keeps waiting for the archive (up to 45 s per call); large exports take a few minutes.')
                 if outcome == 'running' else None)
    result = {'outcome': outcome, 'export': export, 'next': following}
    if note:
        result['note'] = note
    return result


def sentence(result):
    export = result['export']
    count = f"{export['totalItems']} item{'' if export['totalItems'] == 1 else 's'}"
    skipped = f", {len(export['skipped'])} skipped" if export['skipped'] else ''
    return {'completed': f'The ZIP of {count} is ready{skipped}.' + ('' if export['download'] else f" {export['error']}"),
            'running': f'The ZIP of {count} is being built ({export["processedItems"]} done){skipped}. '
                       'Call get_export with wait=true.',
            'failed': f"The ZIP export of {count} failed. {export['error']}",
            'expired': export['error'] or 'This archive has expired.'}[result['outcome']]


def status_of(export_id):
    return MediaExport.objects.filter(pk=export_id).values_list('status', flat=True).first()


def owned(export_id, user_id):
    job = services.owned_export(export_id, user_id)
    if job is None:
        raise not_found(export_id)
    return job


def folder_selection(folder_id, subfolders):
    """The finished, downloadable items in a folder (and its subfolders), oldest first, at most ``MAX_IDS``."""
    if not Folder.objects.filter(pk=folder_id).exists():
        raise errors.ToolError(errors.NOT_FOUND, f'No folder {folder_id} is visible to you. Call list_folders.')
    try:
        rows = reads.source_history(reads.query_params({'folderId': folder_id}), options={'subfolders': subfolders})
    except ValidationError as error:
        raise errors.ToolError(errors.INVALID_INPUT, error.detail.get('error', 'This folder cannot be exported.')) from None
    ids = [str(identifier) for identifier in rows.filter(status='succeeded', kind__in=EXPORTABLE).exclude(Q(url=None) | Q(url=''))
           .order_by('created_at', 'id').values_list('id', flat=True)[:MAX_IDS + 1]]
    if len(ids) > MAX_IDS:
        raise errors.ToolError(errors.INVALID_INPUT, f'This folder has more than {MAX_IDS} items. Export its subfolders '
                                                     'one at a time, or pass up to 5000 ids.')
    return ids


def build(user_id, ids):
    """Create, fill and finalize one export; nothing is kept when none of the items can be exported."""
    created = services.create_export(user_id)
    skipped = []
    for start in range(0, len(ids), services.CHUNK_LIMIT):
        skipped += services.append_items(created['id'], user_id, ids[start:start + services.CHUNK_LIMIT])['rejected']
    if len(skipped) == len(ids):
        raise errors.ToolError(errors.INVALID_INPUT, 'None of these generations has a finished file you can export. '
                                                     'Check them with get_generation.')
    services.finalize_export(created['id'], user_id)
    return {'id': created['id'], 'skipped': skipped}


def create(call):
    arguments, user_id = call.arguments, call.principal.user.id
    if ('ids' in arguments) == ('folderId' in arguments):
        raise errors.ToolError(errors.INVALID_INPUT, 'Pass either ids or folderId (not both).')
    if arguments.get('includeSubfolders') and 'folderId' not in arguments:
        raise errors.ToolError(errors.INVALID_INPUT, 'includeSubfolders needs folderId.')
    if 'ids' in arguments:
        selection = {'ids': list(dict.fromkeys(identifier.lower() for identifier in arguments['ids']))}
    else:
        selection = {'folderId': arguments['folderId'].lower(), 'includeSubfolders': bool(arguments.get('includeSubfolders'))}
    key = arguments.get('idempotencyKey')

    def mutation():
        ids = selection.get('ids') or folder_selection(selection['folderId'], selection['includeSubfolders'])
        if not ids:
            raise errors.ToolError(errors.INVALID_INPUT, 'This folder has no finished items to export.')
        return build(user_id, ids)
    try:
        return idempotency.execute(OPERATION, selection, mutation, actor_id=user_id, idempotency_key=key)
    except idempotency.OrganizationError as error:
        if error.code in paid.CONFLICTS:
            raise errors.ToolError(errors.IDEMPOTENCY_CONFLICT, 'This idempotencyKey was already used with different '
                                                                'arguments. Use a new key.') from None
        raise
    except services.ExportError as error:
        raise errors.ToolError(errors.INVALID_INPUT, f'Veevee could not build this export ({error}). Refresh the '
                                                     'selection with search_generations and try again.') from None


async def reply(call, identifier, *, skipped=(), wait=False):
    note = None
    if wait:
        note = await hold.hold(call, identifier, max_wait_seconds=call.arguments.get('maxWaitSeconds'), read=status_of,
                               terminal=TERMINAL, busy=BUSY_NOTE)
    job = await db(owned, identifier, call.principal.user.id)
    result = await db(export_result, job, skipped, note)
    return ToolResult(result, sentence(result), outcome=result['outcome'])


@register(
    name='export_zip', title='Export a ZIP', scope='veevee.organize', read_only=False, idempotent=True, open_world=False,
    description=('Package generations (by ids or a folder) into one ZIP download. Waits up to 45 s by default.\n'
                 'Pass ids (up to 5000) or folderId (with includeSubfolders to take its subfolders too). Finished images, '
                 'videos and depth maps are packed with their library filenames and folders, exactly like the web ZIP; '
                 'skipped lists ids that cannot be exported. Only you can see your exports. If the result is running, '
                 'call next (get_export with wait=true). Retrying with the same idempotencyKey returns the same export. '
                 + LINK_RULE + ' ' + USER_DATA),
    input_schema=obj({'ids': {'type': 'array', 'items': results.UUID, 'minItems': 1, 'maxItems': MAX_IDS,
                              'description': 'Generation ids, in the order you want them.'},
                      'folderId': {**results.UUID, 'description': 'A folder id from list_folders.'},
                      'includeSubfolders': {'type': 'boolean', 'default': False,
                                            'description': 'With folderId, also export its subfolders.'},
                      'wait': {'type': 'boolean', 'default': True, 'description': 'Wait for the archive to be ready.'},
                      'maxWaitSeconds': WAIT_SECONDS,
                      'idempotencyKey': {**paid.PAID_CONTROLS['idempotencyKey'],
                                         'description': 'Retrying with the same key returns the first export. Without '
                                                        'a key every call makes a new export; use a new key for each '
                                                        'export you mean to make.'}}),
    output_schema=EXPORT_RESULT)
async def export_zip(call):
    made = await db(create, call)
    call.record['exportId'] = made['id']
    return await reply(call, made['id'], skipped=made['skipped'], wait=call.arguments.get('wait', True))


@register(
    name='get_export', title='Get a ZIP export', scope='veevee.read', read_only=True,
    description=('Check a ZIP export and get a fresh download link. Pass wait=true to wait up to 45 s.\n'
                 'Only the person who made an export can see it. skipped is reported by export_zip only. ' + LINK_RULE),
    input_schema=obj({'id': {**results.UUID, 'description': 'The export id from export_zip.'},
                      'wait': {'type': 'boolean', 'default': False, 'description': 'Wait for the archive to be ready.'},
                      'maxWaitSeconds': WAIT_SECONDS}, ('id',)),
    output_schema=EXPORT_RESULT)
async def get_export(call):
    identifier = call.arguments['id'].lower()
    await db(owned, identifier, call.principal.user.id)
    return await reply(call, identifier, wait=call.arguments.get('wait', False))
