import time
import uuid
from django.conf import settings
from django.db import connection, transaction
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.library.models import Folder
from .models import Project


def ensure_default_project():
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(815042)')
        if not Project.objects.exists():
            now = int(time.time()*1000)
            Project.objects.create(id=uuid.uuid4(),name='My Project',brief=None,
                                   created_by=None,created_at=now,updated_at=now)


def read_projects():
    grouped = {}
    for folder in Folder.objects.order_by('created_at'):
        grouped.setdefault(folder.project_id, []).append(
            {'id':str(folder.id),'name':folder.name,'createdAt':folder.created_at})
    results = []
    for project in Project.objects.order_by('created_at'):
        result = {'id':str(project.id),'name':project.name,
                  'createdAt':project.created_at,'updatedAt':project.updated_at,
                  'folders':grouped.get(project.id,[])}
        if project.brief is not None:
            result['brief'] = project.brief
        results.append(result)
    return results


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def project_reads(request):
    if lookup(request) is None:
        return Response({'error':'UNAUTHENTICATED'},status=401)
    ensure_default_project()
    response = Response({'projects':read_projects()})
    if hasattr(request,'renewed_session'):
        response.set_cookie('veevee_session',request.renewed_session,max_age=2592000,
                            httponly=True,samesite='Lax',secure=settings.SESSION_COOKIE_SECURE,path='/')
    return response
