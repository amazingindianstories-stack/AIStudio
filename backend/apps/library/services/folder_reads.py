"""Reading folders, shared by the web views and agent tools.

Folders belong to the shared library: every signed-in user may read every folder, as GET /api/folders always has.
"""
from apps.projects.models import Project
from ..models import Folder


def brief(folder):
    return {'id': str(folder.id), 'name': folder.name, 'color': folder.color,
            'projectId': str(folder.project_id) if folder.project_id else None,
            'parentId': str(folder.parent_id) if folder.parent_id else None}


def full(folder):
    return {**brief(folder), 'nameNormalized': folder.name_normalized,
            'version': folder.version, 'createdAt': folder.created_at,
            'updatedAt': folder.updated_at}


def tree():
    """Every folder, nested: the global library's and each project's, by name."""
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


def ancestry(folder_id):
    """The folder and its ancestors, root first."""
    identifier, visited, breadcrumbs = folder_id, set(), []
    while identifier and identifier not in visited:
        visited.add(identifier)
        folder = Folder.objects.filter(id=identifier).first()
        if folder is None:
            break
        breadcrumbs.insert(0, brief(folder))
        identifier = str(folder.parent_id) if folder.parent_id else None
    return {'breadcrumbs': breadcrumbs}


def children(parent_id=None, project_id=None):
    """A folder's subfolders, or with no parent the top folders of a project (or of the global library), by name."""
    query = Folder.objects.filter(parent_id=parent_id or None)
    if not parent_id:
        query = query.filter(project_id=project_id or None)
    return {'folders': [full(folder) for folder in query.order_by('name')]}
