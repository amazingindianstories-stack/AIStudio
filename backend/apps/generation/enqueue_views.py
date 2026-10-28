from django.conf import settings
from apps.authentication.session import lookup
from apps.canvas.views import node_route, reply, failure, body
from apps.common.leases import now_ms
from .models import Generation
from .serialization import generation_item
from .providers import magnific
from .services import submission
from .services.paid_guard import PaidBudgetHold
from .services.poller import advance_magnific


def json_body(request):
    value = body(request)
    if value is None: raise TypeError('Cannot read properties of null')
    return value if isinstance(value,dict) else {}


def no_store(request, value):
    response = reply(request,value)
    response['Cache-Control'] = 'no-store'
    return response


def respond(request, submit, held):
    """The web answer to a shared submission. A paid-guard hold replies ``held``; paid_guard.wrap_wsgi turns it into its 409."""
    try:
        return reply(request,submit())
    except submission.Refused as refused:
        if refused.body is None: return failure()
        response = reply(request,refused.body,refused.status)
        for name,value in refused.headers.items(): response[name] = value
        return response
    except PaidBudgetHold:
        return reply(request,held,500)


@node_route(['POST'])
def generate(request, kind):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    try:
        data = json_body(request)
    except Exception:
        return failure()
    key = request.headers.get('idempotency-key') or request.headers.get('x-idempotency-key')
    held = {'error':'Failed to save the generation request. Please try again or contact an administrator.' if kind == 'video' else 'Failed to save the generation request.'}
    return respond(request,lambda: submission.submit_generation(user,kind,data,idempotency_key=key),held)


@node_route(['POST'])
def finalize(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    try:
        data = json_body(request)
    except Exception:
        return failure()
    return respond(request,lambda: submission.finalize_draft(user,data.get('sourceGenerationId')),{'error':'Failed to queue the final render.'})


@node_route(['GET'])
def video_status(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    values = request.query_params.getlist('id')
    identifier = values[0] if values else None
    if not identifier: return reply(request,{'error':'Missing id.'},400)
    try:
        row = Generation.objects.filter(pk=identifier).first()
        if row is None: return reply(request,{'error':'Not found.'},404)
        if str(row.user_id) != str(user.id) and user.role != 'admin':
            return reply(request,{'error':'FORBIDDEN'},403)
        item = generation_item(row)
        return no_store(request,{**item,'transientPollError':row.last_poll_error_at is not None,
            'pollErrorCount':row.poll_error_count or 0,'retryAfterMs':max(0,row.next_poll_at-now_ms()) if row.next_poll_at else 0})
    except Exception:
        return failure()


@node_route(['POST'])
def upscale(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    try:
        data = json_body(request)
    except Exception as error:
        return reply(request,{'error':str(error)},400)
    origin = request.build_absolute_uri('/').rstrip('/')
    return respond(request,lambda: submission.submit_upscale(user,data,origin=origin),{'error':'Failed to start upscale generation.'})


@node_route(['GET'])
def upscale_status(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    values = request.query_params.getlist('id')
    identifier = values[0] if values else None
    if not identifier: return reply(request,{'error':'Missing id parameter.'},400)
    try:
        row = Generation.objects.filter(pk=identifier).first()
        if row is None: return reply(request,{'error':'Generation not found.'},404)
        if str(row.user_id) != str(user.id) and user.role != 'admin': return reply(request,{'error':'FORBIDDEN'},403)
        if row.model not in magnific.MODELS or row.kind != 'image':
            return reply(request,{'error':'Generation is not a Magnific job.'},400)
        if str(row.user_id) != str(user.id) and user.role != 'admin': return reply(request,{'error':'FORBIDDEN'},403)
        if settings.LOCAL_DATA_MODE == 'read_only_viewer' or not row.task_id or row.status in ('succeeded','failed','cancelled'): return no_store(request,generation_item(row))
        try:
            result = advance_magnific(row)
            current = Generation.objects.filter(pk=identifier).first() if result['kind']=='raced' else result.get('item')
            return no_store(request,generation_item(current) if current else None)
        except Exception:
            return no_store(request,generation_item(row))
    except Exception:
        return failure()
