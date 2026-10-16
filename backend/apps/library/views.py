from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.projects.models import Project
from .models import Folder


def brief(folder):
    return {'id': str(folder.id), 'name': folder.name, 'color': folder.color,
            'projectId': str(folder.project_id) if folder.project_id else None,
            'parentId': str(folder.parent_id) if folder.parent_id else None}


def full(folder):
    return {**brief(folder), 'nameNormalized': folder.name_normalized,
            'version': folder.version, 'createdAt': folder.created_at,
            'updatedAt': folder.updated_at}


def tree():
    folders = list(Folder.objects.order_by('name'))
    grouped = {}
    for folder in folders:
        key = str(folder.parent_id) if folder.parent_id else ('proj:'+str(folder.project_id) if folder.project_id else 'global:root')
        grouped.setdefault(key, []).append(folder)
    def build(key, visited=frozenset()):
        result = []
        for folder in grouped.get(key, []):
            identifier = str(folder.id)
            result.append({**brief(folder), 'version': folder.version,
                           'children': [] if identifier in visited else build(identifier, visited | {identifier}),
                           'createdAt': folder.created_at, 'updatedAt': folder.updated_at})
        return result
    return {'globalFolders': build('global:root'), 'projects': [
        {'id': str(project.id), 'name': project.name, 'brief': project.brief,
         'createdAt': project.created_at, 'updatedAt': project.updated_at,
         'folders': build('proj:'+str(project.id))} for project in Project.objects.order_by('name')]}


@api_view(['GET', 'POST', 'PATCH', 'DELETE'])
@authentication_classes([])
@permission_classes([])
def folder_reads(request):
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    if request.method != 'GET':
        return folder_mutation(request, user)
    # URLSearchParams.get in current Next reads the first repeated value.
    params = {key: values[0] for key, values in request.query_params.lists()}
    if params.get('tree') in ('1', 'true'):
        result = tree()
    elif params.get('ancestry'):
        identifier = params['ancestry']
        visited, breadcrumbs = set(), []
        while identifier and identifier not in visited:
            visited.add(identifier)
            folder = Folder.objects.filter(id=identifier).first()
            if folder is None:
                break
            breadcrumbs.insert(0, brief(folder))
            identifier = str(folder.parent_id) if folder.parent_id else None
        result = {'breadcrumbs': breadcrumbs}
    else:
        parent = params.get('parentId') or None
        query = Folder.objects.filter(parent_id=parent)
        if not parent:
            query = query.filter(project_id=params.get('projectId') or None)
        result = {'folders': [full(folder) for folder in query.order_by('name')]}
    response = Response(result)
    if hasattr(request, 'renewed_session'):
        from django.conf import settings
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
                            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response


def renew(request, response):
    if hasattr(request, 'renewed_session'):
        from django.conf import settings
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response


def body_or_empty(request):
    # Next's req.json().catch(() => ({})) accepts malformed JSON as an empty body.
    import json
    try:
        result = json.loads(request.body)
        return result if isinstance(result, dict) else {}
    except (ValueError, UnicodeError):
        return {}


def folder_mutation(request, user):
    from .services import folder_engine as service
    from .services.idempotency import MISSING, OrganizationError
    body = body_or_empty(request) if request.method != 'DELETE' else {
        key: values[0] for key, values in request.query_params.lists()}
    key = body.get('idempotencyKey') or request.headers.get('x-idempotency-key') or request.headers.get('idempotency-key')
    common = {'actor_id': str(user.id), 'idempotency_key': key}
    try:
        if request.method == 'POST':
            result = {'folder': service.create_folder(name=body.get('name'), color=body.get('color'),
                project_id=body.get('projectId') or None, parent_id=body.get('parentId') or None, **common)}
            return renew(request, Response(result, status=201))
        identifier = body.get('id') or body.get('folderId')
        if not identifier:
            return renew(request, Response({'error': 'Folder ID is required.'}, status=400))
        if request.method == 'DELETE':
            result = service.delete_folder(folder_id=identifier, project_id=body.get('projectId') or MISSING, **common)
        elif 'color' in body and not isinstance(body.get('name'), str) and not js_truthy(body.get('destination')):
            result = {'folder': service.set_folder_color(folder_id=identifier, color=body['color'], **common)}
        elif isinstance(body.get('name'), str):
            result = {'folder': service.rename_folder(folder_id=identifier, name=body['name'],
                project_id=body.get('projectId', MISSING), expected_version=body.get('expectedVersion', MISSING), **common)}
        elif isinstance(body.get('destination'), (dict, list)):
            result = service.move_folder(folder_id=identifier, destination=body['destination'],
                expected_version=body.get('expectedVersion', MISSING), **common)
        else:
            return renew(request, Response({'error': "Must specify 'name' to rename, 'color' to recolor, or 'destination' to move."}, status=400))
        return renew(request, Response(result))
    except OrganizationError as exc:
        return renew(request, Response({'error': str(exc), 'code': exc.code}, status=exc.status))
    except Exception:
        # Database diagnostics can include credentials or supplied payloads.
        action = {'POST': 'create', 'DELETE': 'delete'}.get(request.method, 'update')
        return renew(request, Response({'error': f'Failed to {action} folder.'}, status=500))


def js_truthy(value):
    return True if isinstance(value, (dict, list)) else bool(value)
