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


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def folder_reads(request):
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
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
