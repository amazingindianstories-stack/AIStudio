"""Board templates and blueprints.

A template is a board v1 graph kept in its own row (or shipped in ``template_catalog``) so it never depends on
the board it came from: its images are copied under ``canvas/templates/<id>/``. Inserting one is a client paste
with fresh ids; starting a board or a blueprint from one happens here (``instantiate``). Visibility is a scope
on the row: personal (its creator), project (people who can see that project) or everyone. The creator or an
admin manages a template; only an admin features one. Likes, comments and usage counts are keyed by a template
ref: ``builtin:<slug>`` for shipped content, the row id for custom rows.
"""
import io
import re
import time
import uuid
from django.db import models, transaction
from apps.authentication.models import User
from . import access, template_catalog
from .models import (Blueprint, BoardTemplate, BoardTemplateComment, BoardTemplateLike, BoardTemplateUsage,
                     CanvasBoard, TEMPLATE_SCOPES)
from .serialization import (JS_WHITESPACE, MAX_BOARD_JSON_UNITS, STAMP_KEYS, content_length, empty_state, utf16_length,
                            validate_state)

UUID_RE = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
BUILTIN_PREFIX = 'builtin:'
CATEGORIES = ('research-design', 'strategy-planning', 'diagramming', 'ideation', 'agile', 'presentation', 'meetings',
              'wireframing', 'image-creation', 'other')
MAX_NAME = 120
MAX_DESCRIPTION = 1000
MAX_TAGS = 8
MAX_TAG = 30
MAX_COMMENT = 1000
MAX_COMMENTS = 200
PREVIEW_RECTS = 80
PREVIEW_SPAN = 1000
BLUEPRINT_MAX_BOARDS = 20
DAY_MS = 24 * 60 * 60 * 1000
# Clearing a selection blanks these; a blank template only blanks stickies, so its headings and frames stay.
CLEAR_TYPES = ('sticky', 'text', 'shape')
BLANK_TYPES = ('sticky',)
CLEAR_KEYS = ('tagIds', 'reactions', 'marks', 'showAuthor') + STAMP_KEYS


class TemplateError(Exception):
    def __init__(self, error, status=400):
        super().__init__(error)
        self.status = status


def now_ms():
    return int(time.time() * 1000)


def is_admin(user):
    return getattr(user, 'role', None) == 'admin'


# ---- graph helpers --------------------------------------------------------------------------------------------

def snapshot(raw):
    """The stored form of a graph: validated, without viewport or server stamps. Raises when it is over the board limit."""
    state = validate_state(raw)
    state.pop('viewport', None)
    for item in [*state['nodes'], *state['connectors']]:
        for key in STAMP_KEYS:
            item.pop(key, None)
    if content_length(state) > MAX_BOARD_JSON_UNITS:
        raise TemplateError('Template is too large to save.', 413)
    return state


def clear_content(graph, types=BLANK_TYPES):
    """The graph with the text, tags, emoji votes and stamps of the nodes of `types` removed, styles kept."""
    nodes = []
    for item in graph['nodes']:
        if item['type'] in types:
            item = {key: value for key, value in item.items() if key not in CLEAR_KEYS}
            if 'text' in item:
                item['text'] = ''
        nodes.append(item)
    return {**graph, 'nodes': nodes}


def instantiate(graph, blank=False):
    """A copy of `graph` with fresh node, connector and group ids, as the data of a new board."""
    source = clear_content(graph) if blank else graph
    ids = {item['id']: str(uuid.uuid4()) for item in source['nodes']}
    groups = {}
    nodes = []
    for item in source['nodes']:
        copy = {**item, 'id': ids[item['id']]}
        if item.get('parentId'):
            copy['parentId'] = ids.get(item['parentId'])
        if item.get('groupId'):
            copy['groupId'] = groups.setdefault(item['groupId'], str(uuid.uuid4()))
        tail = item.get('tail')
        if isinstance(tail, dict) and 'nodeId' in tail:
            if tail['nodeId'] in ids:
                copy['tail'] = {**tail, 'nodeId': ids[tail['nodeId']]}
            else:
                copy.pop('tail')
        nodes.append(copy)
    connectors = []
    for item in source['connectors']:
        copy = {**item, 'id': str(uuid.uuid4())}
        for end in ('from', 'to'):
            if 'nodeId' in item[end]:
                copy[end] = {**item[end], 'nodeId': ids[item[end]['nodeId']]}
        connectors.append(copy)
    state = {**empty_state(), 'nodes': nodes, 'connectors': connectors}
    if graph.get('tags'):
        state['tags'] = graph['tags']
    return validate_state(state)


def preview_of(graph):
    """What the picker draws as a thumbnail: up to PREVIEW_RECTS `[x, y, w, h, kind, color]` boxes scaled so the
    longest side is PREVIEW_SPAN, frames first. Never the graph itself, so lists stay small."""
    nodes = graph['nodes']
    if not nodes:
        return {'w': PREVIEW_SPAN, 'h': PREVIEW_SPAN * 3 // 4, 'rects': []}
    left, top = min(item['x'] for item in nodes), min(item['y'] for item in nodes)
    right, bottom = max(item['x'] + item['w'] for item in nodes), max(item['y'] + item['h'] for item in nodes)
    width, height = max(right - left, 1), max(bottom - top, 1)
    scale = PREVIEW_SPAN / max(width, height)
    kinds = {'frame': 'f', 'sticky': 's', 'text': 't', 'image': 'i'}
    ordered = sorted(nodes, key=lambda item: 0 if item['type'] == 'frame' else 1)[:PREVIEW_RECTS]
    rects = []
    for item in ordered:
        fill = item.get('fill')
        rects.append([round((item['x'] - left) * scale), round((item['y'] - top) * scale),
                      max(1, round(item['w'] * scale)), max(1, round(item['h'] * scale)), kinds.get(item['type'], 'o'),
                      fill if isinstance(fill, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', fill) else None])
    return {'w': max(1, round(width * scale)), 'h': max(1, round(height * scale)), 'rects': rects}


def copy_media(graph, prefix):
    """Copy every canvas image the graph points at under `prefix`, so deleting the source board's media (or the
    board) never breaks the template. A source that cannot be read keeps its original url."""
    from apps.media.storage import MIME, get_storage
    storage = None
    own = f'/api/media/{prefix}/'
    copied = {}
    for item in graph['nodes']:
        src = item.get('src')
        if item['type'] != 'image' or not isinstance(src, str) or not src.startswith('/api/media/canvas/') or src.startswith(own):
            continue
        if src not in copied:
            copied[src] = src
            key = src[len('/api/media/'):]
            try:
                storage = storage or get_storage()
                media = storage.open(key)
                try:
                    data = b''.join(media.stream)
                finally:
                    media.stream.close()
                extension = key.rsplit('.', 1)[-1].lower()
                target = f'{prefix}/{uuid.uuid4()}.{extension}'
                storage.upload_stream(io.BytesIO(data), target, MIME.get(extension, media.content_type), 'private, max-age=0')
                copied[src] = '/api/media/' + target
            except Exception:
                pass
        item['src'] = copied[src]
    return graph


# ---- shared validation ----------------------------------------------------------------------------------------

def clean_name(value, label='Name'):
    name = value.strip(JS_WHITESPACE) if isinstance(value, str) else ''
    if not name:
        raise TemplateError(f'{label} is required.')
    if utf16_length(name) > MAX_NAME:
        raise TemplateError(f'{label} must be {MAX_NAME} characters or fewer.')
    return name


def clean_description(value):
    text = value.strip(JS_WHITESPACE) if isinstance(value, str) else ''
    if utf16_length(text) > MAX_DESCRIPTION:
        raise TemplateError(f'Description must be {MAX_DESCRIPTION} characters or fewer.')
    return text


def clean_category(value):
    if value is None or value == '':
        return 'other'
    if value not in CATEGORIES:
        raise TemplateError('Unknown category.')
    return value


def clean_tags(value):
    result = []
    for item in value if isinstance(value, list) else []:
        tag = item.strip(JS_WHITESPACE).lower() if isinstance(item, str) else ''
        if tag and utf16_length(tag) <= MAX_TAG and tag not in result:
            result.append(tag)
    return result[:MAX_TAGS]


def clean_scope(scope, project_id, user):
    """(scope, project id): a project scope needs a project the user can see."""
    if scope not in TEMPLATE_SCOPES:
        raise TemplateError('Unknown access level.')
    if scope != 'project':
        return scope, None
    if not isinstance(project_id, str) or not UUID_RE.fullmatch(project_id):
        raise TemplateError('A project is required for project access.')
    if not in_project_audience(user, project_id):
        raise TemplateError('Project not found.', 404)
    return scope, project_id


def in_project_audience(user, project_id):
    """Who a project scope reaches: anyone who can see the project (a member, or able to read one of its boards)."""
    from apps.projects.models import ProjectMember
    if is_admin(user) or ProjectMember.objects.filter(project_id=project_id, user_id=user.id).exists():
        return True
    rows = list(CanvasBoard.objects.filter(project_id=project_id).values('id', 'project_id', 'created_by', 'team_role'))
    levels = access.roles_for(user, rows)
    return any(level >= access.READ for level in levels.values())


# ---- reads ----------------------------------------------------------------------------------------------------

def _counts(model, refs, **extra):
    return dict(model.objects.filter(template_ref__in=refs, **extra).values_list('template_ref').annotate(n=models.Count('pk')))


def _authors(ids):
    return {str(row['id']): row['name'] for row in User.objects.filter(id__in=[i for i in ids if i]).values('id', 'name')}


def _decorate(user, entries):
    """Likes, comments and usage counts, and the viewer's own like, on each entry of `entries`."""
    refs = [entry['id'] for entry in entries]
    likes, comments, usage = _counts(BoardTemplateLike, refs), _counts(BoardTemplateComment, refs), _counts(BoardTemplateUsage, refs)
    mine = set(BoardTemplateLike.objects.filter(template_ref__in=refs, user_id=user.id).values_list('template_ref', flat=True))
    names = _authors({entry.get('createdBy') for entry in entries})
    for entry in entries:
        entry.update(likes=likes.get(entry['id'], 0), liked=entry['id'] in mine, commentCount=comments.get(entry['id'], 0),
                     uses=usage.get(entry['id'], 0), author=names.get(entry.get('createdBy')) or entry.get('author') or 'Veevee')
    return entries


def _builtin_entry(item):
    graph = item['graph']
    return {'id': BUILTIN_PREFIX + item['slug'], 'kind': 'builtin', 'name': item['name'], 'description': item['description'],
            'category': item['category'], 'tags': item['tags'], 'scope': 'everyone', 'projectId': None, 'createdBy': None,
            'featured': item.get('featured', False), 'nodeCount': len(graph['nodes']), 'preview': preview_of(graph),
            'defaultView': item.get('defaultView'), 'canManage': False, 'createdAt': 0, 'updatedAt': 0,
            'collections': item.get('collections', []), 'author': 'Veevee'}


def _custom_entry(user, row):
    manage = is_admin(user) or (row.created_by is not None and str(row.created_by) == str(user.id))
    return {'id': str(row.id), 'kind': 'custom', 'name': row.name, 'description': row.description, 'category': row.category,
            'tags': row.tags, 'scope': row.scope, 'projectId': str(row.project_id) if row.project_id else None,
            'createdBy': str(row.created_by) if row.created_by else None, 'featured': row.featured,
            'nodeCount': row.node_count, 'preview': row.preview, 'defaultView': row.default_view, 'canManage': manage,
            'boardId': str(row.board_id) if row.board_id and manage else None, 'collections': [],
            'createdAt': row.created_at, 'updatedAt': row.updated_at}


def visible_rows(user, project_id=None):
    """The custom rows the user may see: their own, everyone's, and the project's when it is the one being viewed."""
    query = models.Q(created_by=user.id) | models.Q(scope='everyone')
    if project_id and UUID_RE.fullmatch(project_id) and in_project_audience(user, project_id):
        query |= models.Q(scope='project', project_id=project_id)
    return BoardTemplate.objects.filter(query, deleted_at__isnull=True)


def list_templates(user, project_id=None):
    entries = [_builtin_entry(item) for item in template_catalog.TEMPLATES]
    entries += [_custom_entry(user, row) for row in visible_rows(user, project_id).order_by('-updated_at')]
    _decorate(user, entries)
    # Featured first, then the most used, then the newest.
    entries.sort(key=lambda entry: (not entry['featured'], -entry['uses'], -entry['updatedAt'], entry['name']))
    return entries


def _row(user, ref, project_id=None, include_deleted=False):
    if not UUID_RE.fullmatch(ref or ''):
        return None
    row = BoardTemplate.objects.filter(pk=ref).first()
    if row is None or (row.deleted_at is not None and not include_deleted):
        return None
    mine = row.created_by is not None and str(row.created_by) == str(user.id)
    if mine or row.scope == 'everyone' or is_admin(user):
        return row
    if row.scope == 'project' and in_project_audience(user, str(row.project_id)):
        return row
    return None


def get_template(user, ref, project_id=None):
    """One template with its graph (`graph`, and `blankGraph` with the stickies cleared), or None."""
    if ref.startswith(BUILTIN_PREFIX):
        item = template_catalog.template(ref[len(BUILTIN_PREFIX):])
        if item is None:
            return None
        entry = _builtin_entry(item)
        graph = item['graph']
    else:
        row = _row(user, ref, project_id)
        if row is None:
            return None
        entry, graph = _custom_entry(user, row), row.graph
    _decorate(user, [entry])
    return {**entry, 'graph': graph, 'blankGraph': clear_content(graph)}


# ---- custom templates -----------------------------------------------------------------------------------------

def _board_graph(user, board_id, level=access.READ):
    row = access.board_row(board_id) if isinstance(board_id, str) and UUID_RE.fullmatch(board_id) else None
    if row is None:
        raise TemplateError('Board not found.', 404)
    access.require(user, row, level)
    return CanvasBoard.objects.filter(pk=board_id).values_list('data', flat=True).first()


def create_template(user, data):
    """From a whole board (`boardId`), from a selection (`graph`), or from scratch (`fromScratch` with a `projectId`:
    an empty template and the ordinary board it is edited in)."""
    name = clean_name(data.get('name'))
    scope, project_id = clean_scope(data.get('scope', 'personal'), data.get('projectId'), user)
    now = now_ms()
    identifier = uuid.uuid4()
    editing_board = None
    if data.get('fromScratch') is True:
        project = data.get('projectId')
        if not isinstance(project, str) or not UUID_RE.fullmatch(project):
            raise TemplateError('A project is required to edit a template.')
        access.require_board_creator(user, project)
        graph = snapshot(empty_state())
    elif data.get('boardId') is not None:
        graph = snapshot(_board_graph(user, data['boardId']))
    elif isinstance(data.get('graph'), dict):
        graph = snapshot(data['graph'])
    else:
        raise TemplateError('A board or a selection is required.')
    if not graph['nodes'] and data.get('fromScratch') is not True:
        raise TemplateError('Nothing to save: the template would be empty.')
    with transaction.atomic():
        copy_media(graph, f'canvas/templates/{identifier}')
        row = BoardTemplate.objects.create(
            id=identifier, name=name, description=clean_description(data.get('description')),
            category=clean_category(data.get('category')), tags=clean_tags(data.get('tags')), scope=scope,
            project_id=project_id, created_by=user.id, graph=graph, preview=preview_of(graph),
            node_count=len(graph['nodes']), default_view=_default_view(data.get('defaultView')),
            created_at=now, updated_at=now)
        if data.get('fromScratch') is True:
            row.board_id = _editing_board(user, row, data['projectId'], graph)
            row.save(update_fields=['board_id'])
    entry = _decorate(user, [_custom_entry(user, row)])[0]
    return entry


def _default_view(value):
    return value if value in ('table', 'timeline', 'doc', 'slides', 'diagram') else None


def _editing_board(user, row, project_id, graph):
    from .services import create_board_with_data
    board = create_board_with_data(project_id, f'Template: {row.name}', user, instantiate_keep_ids(graph))
    return board['id']


def instantiate_keep_ids(graph):
    """A board's data holding the template graph as it is, so saving it back keeps the node ids stable."""
    return validate_state({**empty_state(), **graph})


def open_editing_board(user, ref, project_id):
    """The board a template is edited in: its existing one, or a new one seeded with its graph. Editing a template
    is editing a board, so it inherits board sharing, comments and conflict-safe saves."""
    row = _row(user, ref)
    if row is None:
        raise TemplateError('Template not found.', 404)
    require_manage(user, row)
    if row.board_id and CanvasBoard.objects.filter(pk=row.board_id).exists():
        return str(row.board_id)
    if not isinstance(project_id, str) or not UUID_RE.fullmatch(project_id):
        raise TemplateError('A project is required to edit a template.')
    access.require_board_creator(user, project_id)
    row.board_id = _editing_board(user, row, project_id, row.graph)
    row.save(update_fields=['board_id'])
    return str(row.board_id)


def require_manage(user, row):
    if not is_admin(user) and (row.created_by is None or str(row.created_by) != str(user.id)):
        raise TemplateError('Only the template owner or an admin can change this template.', 403)


def update_template(user, ref, data):
    """Edit details (name, description, category, tags, access, default view), restore a deleted template
    (`deleted: false`), feature it (admins), or replace its content from its editing board (`syncBoard: true`)."""
    row = _row(user, ref, include_deleted=True)
    if row is None:
        raise TemplateError('Template not found.', 404)
    require_manage(user, row)
    if 'featured' in data:
        if not is_admin(user):
            raise TemplateError('Only an admin can feature templates.', 403)
        row.featured = bool(data['featured'])
    if 'name' in data:
        row.name = clean_name(data['name'])
    if 'description' in data:
        row.description = clean_description(data['description'])
    if 'category' in data:
        row.category = clean_category(data['category'])
    if 'tags' in data:
        row.tags = clean_tags(data['tags'])
    if 'defaultView' in data:
        row.default_view = _default_view(data['defaultView'])
    if 'scope' in data:
        row.scope, row.project_id = clean_scope(data['scope'], data.get('projectId') or (str(row.project_id) if row.project_id else None), user)
    if data.get('deleted') is False:
        row.deleted_at = None
    if data.get('syncBoard') is True:
        if not row.board_id:
            raise TemplateError('This template has no editing board.')
        graph = snapshot(_board_graph(user, str(row.board_id), access.WRITE))
        if not graph['nodes']:
            raise TemplateError('Nothing to save: the template would be empty.')
        copy_media(graph, f'canvas/templates/{row.id}')
        row.graph, row.preview, row.node_count = graph, preview_of(graph), len(graph['nodes'])
    row.updated_at = now_ms()
    row.save()
    return _decorate(user, [_custom_entry(user, row)])[0]


def delete_template(user, ref):
    """Soft delete, so the toast can undo it. Likes, comments and usage counts stay."""
    row = _row(user, ref)
    if row is None:
        raise TemplateError('Template not found.', 404)
    require_manage(user, row)
    row.deleted_at = now_ms()
    row.save(update_fields=['deleted_at'])


def template_for_board(user, board_id):
    """The template a board is the editing board of, when the user manages it."""
    if not UUID_RE.fullmatch(board_id or ''):
        return None
    row = BoardTemplate.objects.filter(board_id=board_id, deleted_at__isnull=True).first()
    if row is None:
        return None
    mine = row.created_by is not None and str(row.created_by) == str(user.id)
    if not (mine or is_admin(user) or row.scope == 'everyone'):
        return None
    return _custom_entry(user, row)


# ---- likes, comments and usage --------------------------------------------------------------------------------

def _known(user, ref, project_id=None):
    if ref.startswith(BUILTIN_PREFIX):
        item = template_catalog.template(ref[len(BUILTIN_PREFIX):])
        return (item['name'], 'builtin') if item else None
    blueprint = ref.startswith('blueprint:')
    if blueprint:
        found = get_blueprint(user, ref[len('blueprint:'):])
        return (found['name'], 'blueprint') if found else None
    row = _row(user, ref, project_id)
    return (row.name, 'custom') if row else None


def set_like(user, ref, liked):
    if _known(user, ref) is None:
        raise TemplateError('Template not found.', 404)
    if liked:
        BoardTemplateLike.objects.get_or_create(template_ref=ref, user_id=user.id, defaults={'created_at': now_ms()})
    else:
        BoardTemplateLike.objects.filter(template_ref=ref, user_id=user.id).delete()
    return {'liked': bool(liked), 'likes': BoardTemplateLike.objects.filter(template_ref=ref).count()}


def liked_refs(user):
    return list(BoardTemplateLike.objects.filter(user_id=user.id).values_list('template_ref', flat=True))


def list_comments(user, ref):
    if _known(user, ref) is None:
        raise TemplateError('Template not found.', 404)
    rows = list(BoardTemplateComment.objects.filter(template_ref=ref).order_by('-created_at')[:MAX_COMMENTS])
    names = _authors({str(row.user_id) for row in rows if row.user_id})
    return [{'id': str(row.id), 'body': row.body, 'createdAt': row.created_at, 'author': names.get(str(row.user_id)) or 'Someone',
             'mine': str(row.user_id) == str(user.id)} for row in reversed(rows)]


def add_comment(user, ref, body):
    if _known(user, ref) is None:
        raise TemplateError('Template not found.', 404)
    text = body.strip(JS_WHITESPACE) if isinstance(body, str) else ''
    if not text:
        raise TemplateError('Comment is required.')
    if utf16_length(text) > MAX_COMMENT:
        raise TemplateError(f'Comment must be {MAX_COMMENT} characters or fewer.')
    BoardTemplateComment.objects.create(id=uuid.uuid4(), template_ref=ref, user_id=user.id, body=text, created_at=now_ms())
    return list_comments(user, ref)


def record_usage(user, ref, board_id=None):
    """One insertion of a template, or one use of a blueprint. Simple counts for the admin insights."""
    known = _known(user, ref)
    if known is None:
        raise TemplateError('Template not found.', 404)
    BoardTemplateUsage.objects.create(
        id=uuid.uuid4(), template_ref=ref, kind=known[1], name=known[0], user_id=user.id,
        board_id=board_id if isinstance(board_id, str) and UUID_RE.fullmatch(board_id) else None, created_at=now_ms())


def usage_insights(now=None):
    """Uses of each template and blueprint in the last 30 days and the last year, most used first."""
    now = now or now_ms()
    month, year = now - 30 * DAY_MS, now - 365 * DAY_MS
    rows = BoardTemplateUsage.objects.filter(created_at__gte=year).values('template_ref', 'kind').annotate(
        name=models.Max('name'), year=models.Count('pk'),
        month=models.Count('pk', filter=models.Q(created_at__gte=month)))
    result = [{'ref': row['template_ref'], 'kind': row['kind'], 'name': row['name'], 'last30Days': row['month'],
               'lastYear': row['year']} for row in rows]
    result.sort(key=lambda item: (-item['last30Days'], -item['lastYear'], item['name']))
    return result


# ---- boards and blueprints from templates ---------------------------------------------------------------------

def graph_for_new_board(user, ref, blank=False):
    """The data of a new board started from template `ref`."""
    found = get_template(user, ref)
    if found is None:
        raise TemplateError('Template not found.', 404)
    return instantiate(found['graph'], blank=blank), found


def _builtin_blueprint(item):
    return {'id': 'blueprint:builtin:' + item['slug'], 'kind': 'builtin', 'name': item['name'], 'description': item['description'],
            'scope': 'everyone', 'projectId': None, 'createdBy': None, 'featured': item.get('featured', False),
            'canManage': False, 'boards': [{'name': board['name'], 'nodeCount': len(template_catalog.template(board['template'])['graph']['nodes'])}
                                           for board in item['boards']], 'createdAt': 0, 'updatedAt': 0, 'author': 'Veevee'}


def _custom_blueprint(user, row):
    manage = is_admin(user) or (row.created_by is not None and str(row.created_by) == str(user.id))
    return {'id': 'blueprint:' + str(row.id), 'kind': 'custom', 'name': row.name, 'description': row.description,
            'scope': row.scope, 'projectId': str(row.project_id) if row.project_id else None,
            'createdBy': str(row.created_by) if row.created_by else None, 'featured': row.featured, 'canManage': manage,
            'boards': [{'name': board['name'], 'nodeCount': len(board['graph']['nodes'])} for board in row.boards],
            'createdAt': row.created_at, 'updatedAt': row.updated_at}


def _blueprint_row(user, identifier, include_deleted=False):
    if not UUID_RE.fullmatch(identifier or ''):
        return None
    row = Blueprint.objects.filter(pk=identifier).first()
    if row is None or (row.deleted_at is not None and not include_deleted):
        return None
    mine = row.created_by is not None and str(row.created_by) == str(user.id)
    if mine or row.scope == 'everyone' or is_admin(user):
        return row
    return row if row.scope == 'project' and in_project_audience(user, str(row.project_id)) else None


def list_blueprints(user, project_id=None):
    entries = [_builtin_blueprint(item) for item in template_catalog.BLUEPRINTS]
    query = models.Q(created_by=user.id) | models.Q(scope='everyone')
    if project_id and UUID_RE.fullmatch(project_id) and in_project_audience(user, project_id):
        query |= models.Q(scope='project', project_id=project_id)
    entries += [_custom_blueprint(user, row) for row in Blueprint.objects.filter(query, deleted_at__isnull=True).order_by('-updated_at')]
    names = _authors({entry.get('createdBy') for entry in entries})
    refs = [entry['id'] for entry in entries]
    uses = _counts(BoardTemplateUsage, refs)
    for entry in entries:
        entry['author'] = names.get(entry.get('createdBy')) or entry['author']
        entry['uses'] = uses.get(entry['id'], 0)
    entries.sort(key=lambda entry: (not entry['featured'], -entry['uses'], entry['name']))
    return entries


def get_blueprint(user, identifier):
    if identifier.startswith('builtin:'):
        item = template_catalog.blueprint(identifier[len('builtin:'):])
        return _builtin_blueprint(item) if item else None
    row = _blueprint_row(user, identifier)
    return _custom_blueprint(user, row) if row else None


def create_blueprint(user, data):
    """Snapshot every board of a project (those the user can read) as a custom blueprint."""
    name = clean_name(data.get('name'))
    scope, project_id = clean_scope(data.get('scope', 'personal'), data.get('projectId'), user)
    source = data.get('sourceProjectId')
    if not isinstance(source, str) or not UUID_RE.fullmatch(source):
        raise TemplateError('A project is required.')
    rows = list(CanvasBoard.objects.filter(project_id=source).order_by('created_at').values(
        'id', 'project_id', 'created_by', 'team_role', 'name', 'data'))
    levels = access.roles_for(user, rows)
    rows = [row for row in rows if levels[str(row['id'])] >= access.READ][:BLUEPRINT_MAX_BOARDS]
    if not rows:
        raise TemplateError('The project has no boards to save.')
    identifier = uuid.uuid4()
    boards = []
    with transaction.atomic():
        for row in rows:
            graph = snapshot(row['data'])
            copy_media(graph, f'canvas/blueprints/{identifier}')
            boards.append({'name': row['name'], 'graph': graph})
        now = now_ms()
        saved = Blueprint.objects.create(id=identifier, name=name, description=clean_description(data.get('description')),
                                         scope=scope, project_id=project_id, created_by=user.id, boards=boards,
                                         created_at=now, updated_at=now)
    return _custom_blueprint(user, saved)


def update_blueprint(user, identifier, data):
    row = _blueprint_row(user, identifier, include_deleted=True)
    if row is None:
        raise TemplateError('Blueprint not found.', 404)
    require_manage(user, row)
    if 'featured' in data:
        if not is_admin(user):
            raise TemplateError('Only an admin can feature blueprints.', 403)
        row.featured = bool(data['featured'])
    if 'name' in data:
        row.name = clean_name(data['name'])
    if 'description' in data:
        row.description = clean_description(data['description'])
    if 'scope' in data:
        row.scope, row.project_id = clean_scope(data['scope'], data.get('projectId') or (str(row.project_id) if row.project_id else None), user)
    if data.get('deleted') is False:
        row.deleted_at = None
    row.updated_at = now_ms()
    row.save()
    return _custom_blueprint(user, row)


def delete_blueprint(user, identifier):
    row = _blueprint_row(user, identifier)
    if row is None:
        raise TemplateError('Blueprint not found.', 404)
    require_manage(user, row)
    row.deleted_at = now_ms()
    row.save(update_fields=['deleted_at'])


def use_blueprint(user, identifier, name):
    """One project and one board per blueprint board, in a single transaction. Returns the new project and its
    boards; a blueprint changed later never changes projects already made from it."""
    from apps.projects.services.projects import create_project
    from .services import create_board_with_data, list_boards
    project_name = clean_name(name, 'Project name')
    if identifier.startswith('builtin:'):
        item = template_catalog.blueprint(identifier[len('builtin:'):])
        if item is None:
            raise TemplateError('Blueprint not found.', 404)
        boards = [(board['name'], template_catalog.template(board['template'])['graph']) for board in item['boards']]
        ref = 'blueprint:' + identifier
    else:
        row = _blueprint_row(user, identifier)
        if row is None:
            raise TemplateError('Blueprint not found.', 404)
        boards = [(board['name'], board['graph']) for board in row.boards]
        ref = 'blueprint:' + str(row.id)
    with transaction.atomic():
        created = create_project(project_name, user.id)
        project = created['project']
        made = [create_board_with_data(project['id'], board_name, user, instantiate(graph)) for board_name, graph in boards]
        record_usage(user, ref)
    return {'project': project, 'projects': created['projects'], 'boards': made, 'allBoards': list_boards(project['id'], user)}
