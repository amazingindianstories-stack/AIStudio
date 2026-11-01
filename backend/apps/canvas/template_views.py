"""Template and blueprint routes: library, custom templates, likes and comments, usage, blueprints."""
from apps.authentication.session import lookup
from . import access, templates
from .views import body, failure, node_route, property_of, reply

BLUEPRINT_PREFIX = 'blueprint:'


def signed_in(handler):
    """Run `handler(request, user, *args)` for a signed-in user, mapping template and access errors to replies."""
    def run(request, *args, **kwargs):
        user = lookup(request)
        if user is None:
            return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
        try:
            return handler(request, user, *args, **kwargs)
        except templates.TemplateError as error:
            return reply(request, {'error': str(error)}, error.status)
        except access.AccessError as error:
            return reply(request, {'error': str(error)}, error.status)
        except Exception:
            return failure()
    run.__name__ = handler.__name__
    return run


def payload(request):
    data = body(request)
    if not isinstance(data, dict):
        raise templates.TemplateError('Invalid request.')
    return data


def first(request, name):
    values = request.query_params.getlist(name)
    return values[0] if values else None


@node_route(['GET', 'POST'])
@signed_in
def template_list(request, user):
    if request.method in ('GET', 'HEAD'):
        return reply(request, {'templates': templates.list_templates(user, first(request, 'projectId')),
                               'categories': list(templates.CATEGORIES), 'isAdmin': templates.is_admin(user)})
    return reply(request, {'template': templates.create_template(user, payload(request))}, 201)


@node_route(['GET', 'PATCH', 'DELETE'])
@signed_in
def template_detail(request, user, ref):
    if request.method in ('GET', 'HEAD'):
        found = templates.get_template(user, ref, first(request, 'projectId'))
        return reply(request, {'template': found}) if found else reply(request, {'error': 'Template not found.'}, 404)
    if request.method == 'DELETE':
        templates.delete_template(user, ref)
        return reply(request, {'ok': True})
    return reply(request, {'template': templates.update_template(user, ref, payload(request))})


@node_route(['GET'])
@signed_in
def template_for_board(request, user, board_id):
    return reply(request, {'template': templates.template_for_board(user, board_id)})


@node_route(['POST'])
@signed_in
def template_edit_board(request, user, ref):
    return reply(request, {'boardId': templates.open_editing_board(user, ref, property_of(payload(request), 'projectId'))})


@node_route(['POST'])
@signed_in
def template_use(request, user, ref):
    templates.record_usage(user, ref, property_of(payload(request), 'boardId'))
    return reply(request, {'ok': True})


@node_route(['POST'])
@signed_in
def template_like(request, user, ref):
    return reply(request, templates.set_like(user, ref, property_of(payload(request), 'liked') is not False))


@node_route(['GET', 'POST'])
@signed_in
def template_comments(request, user, ref):
    if request.method in ('GET', 'HEAD'):
        return reply(request, {'comments': templates.list_comments(user, ref)})
    return reply(request, {'comments': templates.add_comment(user, ref, property_of(payload(request), 'body'))}, 201)


@node_route(['GET', 'POST'])
@signed_in
def blueprint_list(request, user):
    if request.method in ('GET', 'HEAD'):
        return reply(request, {'blueprints': templates.list_blueprints(user, first(request, 'projectId'))})
    return reply(request, {'blueprint': templates.create_blueprint(user, payload(request))}, 201)


def blueprint_id(ref):
    return ref[len(BLUEPRINT_PREFIX):] if ref.startswith(BLUEPRINT_PREFIX) else ref


@node_route(['PATCH', 'DELETE'])
@signed_in
def blueprint_detail(request, user, ref):
    if request.method == 'DELETE':
        templates.delete_blueprint(user, blueprint_id(ref))
        return reply(request, {'ok': True})
    return reply(request, {'blueprint': templates.update_blueprint(user, blueprint_id(ref), payload(request))})


@node_route(['POST'])
@signed_in
def blueprint_use(request, user, ref):
    return reply(request, templates.use_blueprint(user, blueprint_id(ref), property_of(payload(request), 'name')), 201)
