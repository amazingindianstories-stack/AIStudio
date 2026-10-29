import json
from django.conf import settings
from django.http import HttpResponse
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from apps.authentication.session import lookup
from . import access, services
from .serialization import JS_WHITESPACE, js_json, json_length, validate_state

MAX_BOARD_JSON_UNITS = 2 * 1024 * 1024


def node_route(methods):
    """Preserve Next's implicit HEAD/OPTIONS and empty unsupported-method body."""
    allowed = list(methods) + (['HEAD'] if 'GET' in methods else []) + ['OPTIONS']

    def decorate(handler):
        def dispatch(request, *args, **kwargs):
            if request.method == 'OPTIONS':
                response = HttpResponse(status=204)
                del response['Content-Type']
                response['Allow'] = ', '.join(sorted(allowed))
                return response
            if request.method not in ('GET', 'HEAD'):
                # Generation routes share this JSON reader. Bound the stream
                # before decoding, including unknown-length request bodies.
                limit = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
                if limit is not None:
                    try:
                        declared = int(request.META.get('CONTENT_LENGTH') or 0)
                    except (ValueError, TypeError):
                        return HttpResponse('{"error":"INVALID_CONTENT_LENGTH"}', status=400, content_type='application/json')
                    if declared > limit:
                        return HttpResponse('{"error":"REQUEST_TOO_LARGE"}', status=413, content_type='application/json')
                    raw = request.read(limit + 1)
                    if len(raw) > limit:
                        return HttpResponse('{"error":"REQUEST_TOO_LARGE"}', status=413, content_type='application/json')
                    request.bounded_json_body = raw
            return handler(request, *args, **kwargs)
        dispatch.__name__ = handler.__name__
        view = api_view(allowed)(permission_classes([])(authentication_classes([])(dispatch)))
        def unsupported(self, request, *args, **kwargs):
            response = HttpResponse(status=405)
            del response['Content-Type']
            return response
        view.cls.http_method_not_allowed = unsupported
        view.cls.default_response_headers = property(lambda self: {})
        return view
    return decorate


def with_renewal(request, response):
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response


def reply(request, payload, status=200):
    return with_renewal(request, HttpResponse(js_json(payload), status=status, content_type='application/json'))


def failure():
    response = HttpResponse(status=500)
    del response['Content-Type']
    return response


def body(request):
    # The transport cap bounds allocation; canvas additionally checks its
    # source JSON.stringify(data).length limit measured in UTF-16 units.
    try:
        raw = getattr(request, 'bounded_json_body', None)
        if raw is None:
            limit = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
            raw = request.read(limit + 1 if limit is not None else None)
            if limit is not None and len(raw) > limit:
                raise ValueError('Request body exceeds the configured limit.')
        return json.loads(raw.decode('utf-8', errors='replace'), parse_int=float,
                          parse_float=float, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    except (ValueError, UnicodeError):
        return {}


def property_of(value, key):
    if value is None:
        raise TypeError('Cannot read a property of null')
    return value.get(key) if isinstance(value, dict) else None


def truthy(value):
    # Empty arrays/objects are truthy in JavaScript.
    return value is not None and value is not False and value != 0 and value != ''


def name_value(value):
    value = value if truthy(value) else ''
    if not isinstance(value, str):
        raise TypeError('Name must support trim')
    return value.strip(JS_WHITESPACE)


def board_list(project, user):
    return {'boards': services.list_boards(project, user), 'canCreate': access.can_create_board(user, project)}


@node_route(['GET', 'POST'])
def board_metadata_reads(request):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        if request.method in ('GET', 'HEAD'):
            values = request.query_params.getlist('projectId')
            project = values[0] if values else None
            if not project:
                return reply(request, {'error': 'projectId required.'}, 400)
            return reply(request, board_list(project, user))
        data = body(request)
        operation = property_of(data, 'op')
        if operation == 'createBoard':
            name = name_value(property_of(data, 'name'))
            project = property_of(data, 'projectId')
            if not truthy(project):
                return reply(request, {'error': 'projectId required.'}, 400)
            access.require_board_creator(user, project)
            if not name:
                return reply(request, {'error': 'Name required.'}, 400)
            board = services.create_board(project, name, user)
            return reply(request, {**board_list(project, user), 'board': board})
        if operation in ('renameBoard', 'deleteBoard'):
            identifier = property_of(data, 'id')
            if not truthy(identifier):
                return reply(request, {'error': 'id required.'}, 400)
            existing = access.board_row(identifier)
            if existing is None:
                return reply(request, {'error': 'Board not found.'}, 404)
            access.require(user, existing, access.SHARE if operation == 'renameBoard' else access.OWN)
            if operation == 'renameBoard':
                services.rename_board(identifier, name_value(property_of(data, 'name')))
            else:
                services.delete_board(identifier)
            return reply(request, board_list(existing['project_id'], user))
        return reply(request, {'error': 'Unknown op.'}, 400)
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        # Next returns an empty 500 for uncaught DB/body-type failures.
        return failure()


@node_route(['GET', 'PUT'])
def board_detail(request, identifier):
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        existing = access.board_row(identifier)
        if request.method in ('GET', 'HEAD'):
            if existing is None:
                return reply(request, {'error': 'Board not found.'}, 404)
            level = access.require(user, existing, access.READ)
            board = services.get_board(identifier)
            return reply(request, {**board, 'role': access.LEVEL_NAMES[level]}) if board else reply(request, {'error': 'Board not found.'}, 404)
        # A missing board keeps the frozen validate-then-404 order; an existing one checks the role first.
        if existing is not None:
            access.require(user, existing, access.WRITE)
        data = property_of(body(request), 'data')
        if not isinstance(data, dict):
            return reply(request, {'error': 'Invalid board data.'}, 400)
        if json_length(data) > MAX_BOARD_JSON_UNITS:
            return reply(request, {'error': 'Board is too large to save.'}, 413)
        updated = services.save_board(identifier, validate_state(data))
        if updated is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        return reply(request, {'ok': True, 'updatedAt': updated})
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        return failure()


@node_route(['POST'])
def board_upload(request, identifier):
    actor = lookup(request)
    if actor is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        import re
        existing = access.board_row(identifier) if re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', identifier) else None
        if existing is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        access.require(actor, existing, access.WRITE)
        payload = body(request)
        reference_id = property_of(payload, 'referenceId')
        if reference_id:
            from apps.media.uploads import resolve_ready_upload, UploadError
            from apps.media.storage import get_storage, MIME
            import tempfile
            from uuid import uuid4
            try:
                upload = resolve_ready_upload(str(actor.id), reference_id, purposes={'canvas'})
                storage = get_storage()
                ext = next((ext for ext, mime in MIME.items() if mime == upload.content_type), 'png')
                key = f'canvas/{identifier}/{uuid4()}.{ext}'
                media = storage.open(upload.key)
                try:
                    with tempfile.TemporaryFile() as staged:
                        for chunk in media.stream:
                            staged.write(chunk)
                        staged.seek(0)
                        storage.upload_stream(staged, key, upload.content_type, 'private, max-age=0')
                finally:
                    media.stream.close()
                return reply(request, {'url': '/api/media/' + key})
            except UploadError as error:
                return reply(request, {'error': str(error)}, error.status)
        data_url = property_of(payload, 'dataUrl')
        if not isinstance(data_url, str) or not data_url.startswith('data:'):
            return reply(request, {'error': 'dataUrl required.'}, 400)
        try:
            from apps.media.images import save_canvas_asset
            url = save_canvas_asset(data_url, identifier)
        except Exception:
            return reply(request, {'error': 'Upload failed.'}, 400)
        return reply(request, {'url': url})
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        return failure()


BOARD_ACCESS_OPERATIONS = {
    'setMember': lambda user, board, data: access.set_board_member(user, board, property_of(data, 'userId'), property_of(data, 'role')),
    'removeMember': lambda user, board, data: access.remove_board_member(user, board, property_of(data, 'userId')),
    'setTeamRole': lambda user, board, data: access.set_team_role(user, board, property_of(data, 'role')),
    'transferOwner': lambda user, board, data: access.transfer_owner(user, board, property_of(data, 'userId')),
}


@node_route(['GET', 'POST'])
def board_access(request, identifier):
    """Who has access to a board, and the owner's and sharers' changes to it."""
    user = lookup(request)
    if user is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        existing = access.board_row(identifier)
        if existing is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        access.require(user, existing, access.READ)
        if request.method == 'POST':
            data = body(request)
            operation = BOARD_ACCESS_OPERATIONS.get(property_of(data, 'op'))
            if operation is None:
                return reply(request, {'error': 'Unknown op.'}, 400)
            operation(user, existing, data)
            existing = access.board_row(identifier)
        return reply(request, access.describe(user, existing))
    except access.AccessError as error:
        return reply(request, {'error': str(error)}, error.status)
    except Exception:
        return failure()


def ai_board(identifier):
    import re
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', identifier):
        return None
    return CanvasBoard.objects.filter(pk=identifier).first()


def ai_failure(request, error):
    """The answer a refused board AI request gets (the same bodies the generation API gives)."""
    from apps.generation.services.paid_guard import PaidBudgetHold
    from apps.generation.services.submission import Refused
    from .ai_jobs import JobError
    if isinstance(error, JobError):
        return reply(request, error.body, error.status)
    if isinstance(error, Refused):
        response = reply(request, error.body, error.status) if error.body else failure()
        for name, value in error.headers.items():
            response[name] = value
        return response
    if isinstance(error, PaidBudgetHold):
        return reply(request, {'error': str(error), 'code': PaidBudgetHold.code}, 409)
    raise error


@node_route(['GET', 'POST'])
def board_ai_jobs(request, identifier):
    from . import ai_jobs
    actor = lookup(request)
    if actor is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        board = ai_board(identifier)
        if board is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        if request.method in ('GET', 'HEAD'):
            ids = [value for raw in request.query_params.getlist('ids') for value in raw.split(',') if value]
            recent = request.query_params.get('recent') == '1'
            return reply(request, {'jobs': ai_jobs.jobs(actor, board, ids, recent)})
        try:
            job = ai_jobs.submit(actor, board, body(request), request.headers.get('Idempotency-Key'))
        except Exception as error:
            return ai_failure(request, error)
        return reply(request, {'job': job}, 201)
    except Exception:
        return failure()


@node_route(['POST'])
def board_ai_quote(request, identifier):
    from . import ai_jobs
    actor = lookup(request)
    if actor is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        board = ai_board(identifier)
        if board is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        try:
            return reply(request, {'quote': ai_jobs.quote(actor, board, body(request))})
        except Exception as error:
            return ai_failure(request, error)
    except Exception:
        return failure()


@node_route(['PATCH'])
def board_ai_job(request, identifier, job_id):
    from . import ai_jobs
    actor = lookup(request)
    if actor is None:
        return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        board = ai_board(identifier)
        if board is None:
            return reply(request, {'error': 'Board not found.'}, 404)
        try:
            return reply(request, {'job': ai_jobs.mark_placed(actor, board, job_id, body(request))})
        except Exception as error:
            return ai_failure(request, error)
    except Exception:
        return failure()
