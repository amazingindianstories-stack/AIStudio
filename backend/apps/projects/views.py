from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.library.views import body_or_empty, renew
from apps.library.services import folder_engine as folders
from apps.library.services.idempotency import MISSING, OrganizationError
from apps.generation.watermark import WHITESPACE
from .services.projects import (ensure_default_project, read_projects, create_project,
    rename_project, set_brief, delete_project)


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def project_reads(request):
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    if request.method == 'GET':
        from django.conf import settings
        return renew(request, Response({'projects': read_projects() if settings.LOCAL_DATA_MODE == 'read_only_viewer' else ensure_default_project()}))
    body = body_or_empty(request)
    operation = body.get('op')
    try:
        if operation in ('createProject', 'renameProject', 'createFolder', 'renameFolder'):
            name = body.get('name') or ''
            if not isinstance(name, str):
                raise TypeError('name must be a string')
            name = name.strip(WHITESPACE)
            if operation in ('createProject', 'createFolder') and not name:
                return renew(request, Response({'error': 'Name required.'}, status=400))
        if operation == 'createProject':
            result = create_project(name, user.id)
        elif operation == 'renameProject':
            result = {'projects': rename_project(body.get('projectId'), name)}
        elif operation == 'setBrief':
            result = {'projects': set_brief(body.get('projectId'), body.get('brief') or '')}
        elif operation == 'deleteProject':
            result = {'projects': delete_project(body.get('projectId'), str(user.id))}
        elif operation == 'createFolder':
            row = folders.create_folder(project_id=body.get('projectId') or None, name=name)
            result = {'projects': read_projects(), 'folder': {key: row[key] for key in ('id', 'name', 'createdAt')}}
        elif operation == 'renameFolder':
            folders.rename_folder(folder_id=body.get('folderId'), project_id=body.get('projectId', MISSING), name=name)
            result = {'projects': read_projects()}
        elif operation == 'deleteFolder':
            folders.delete_folder(folder_id=body.get('folderId'), project_id=body.get('projectId', MISSING), actor_id=str(user.id))
            result = {'projects': read_projects()}
        else:
            return renew(request, Response({'error': 'Unknown op.'}, status=400))
        return renew(request, Response(result))
    except OrganizationError as exc:
        return renew(request, Response({'error': str(exc), 'code': exc.code}, status=exc.status))
    except Exception:
        return renew(request, Response({'error': 'Failed to process project operation.'}, status=500))


@api_view(['GET', 'POST'])
@authentication_classes([])
@permission_classes([])
def project_members(request, project_id):
    """Project roles apply to every board in the project; owners and co-owners change them."""
    from apps.canvas import access
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    try:
        if not access.project_exists(project_id):
            return renew(request, Response({'error': 'Project not found.'}, status=404))
        if request.method == 'POST':
            body = body_or_empty(request)
            operation = body.get('op')
            if operation == 'setMember':
                access.set_project_member(user, project_id, body.get('userId'), body.get('role'))
            elif operation == 'removeMember':
                access.remove_project_member(user, project_id, body.get('userId'))
            else:
                return renew(request, Response({'error': 'Unknown op.'}, status=400))
        return renew(request, Response(access.describe_project(user, project_id)))
    except access.AccessError as exc:
        return renew(request, Response({'error': str(exc)}, status=exc.status))
    except Exception:
        return renew(request, Response({'error': 'Failed to process project members.'}, status=500))
