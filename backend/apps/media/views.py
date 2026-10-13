import json
import math
import re
import time
import tempfile
from urllib.parse import quote
from django.conf import settings
from django.core.exceptions import ValidationError
from django.http import HttpResponse, JsonResponse, StreamingHttpResponse
from django.views.decorators.http import require_http_methods
from apps.authentication.session import lookup
from apps.generation.models import Generation
from apps.library.filenames import batch_resolve_generation_filenames
from .grants import verify_media_grant
from .keys import validate_key, InvalidMediaKey, media_key_from_ref, is_export_key
from .storage import get_storage, MediaNotFoundError, InvalidMediaRangeError, FileSystemAdapter
from .uploads import (create_upload_presign, verify_upload, initialize_upload,
    upload_status, finalize_upload, stream_local_chunk, cancel_upload, UploadError)
from .images import is_thumbnailable, thumb_key, thumbnail_bytes


def _body(request):
    try:
        body = json.loads(request.body)
        return body if isinstance(body, dict) else {}
    except (ValueError, UnicodeError):
        return {}


def _cookie_valid(request):
    return lookup(request) is not None


def _stream_response(media, *, head=False, cache='private, max-age=31536000, immutable', disposition=None):
    if head:
        media.stream.close()
        response = HttpResponse(status=media.status, content_type=media.content_type)
    else:
        response = StreamingHttpResponse(media.stream, status=media.status, content_type=media.content_type)
    response['Content-Length'] = str(media.content_length)
    response['Cache-Control'] = cache
    response['Accept-Ranges'] = 'bytes'
    response['X-Content-Type-Options'] = 'nosniff'
    if media.content_range:
        response['Content-Range'] = media.content_range
    if disposition:
        response['Content-Disposition'] = disposition
    return response


def _redirect(url, cache=None):
    response = HttpResponse(status=307)
    response['Location'] = url
    if cache:
        response['Cache-Control'] = cache
    return response


def _width(raw):
    try:
        value = float(raw)
        return math.floor(min(1600,max(32,value))+0.5) if math.isfinite(value) and value > 0 else None
    except (ValueError, TypeError):
        return None


@require_http_methods(['GET'])
def media(request, path):
    user = lookup(request)
    if not user:
        return JsonResponse({'error':'UNAUTHENTICATED'},status=401)
    try:
        key = validate_key(path)
        # New staging objects are private. Published material/portrait rows keep
        # the existing shared-studio read policy; historical objects are unchanged.
        original_key = key
        while match := re.fullmatch(r'thumbs/[0-9]+/(.+)\.webp', original_key):
            original_key = match[1]
        if original_key.startswith('uploads/'):
            from .models import UploadSession
            from apps.assets.models import Asset, PortraitAsset
            staged = UploadSession.objects.filter(key=original_key).first()
            if staged:
                if not staged.finalized_at or staged.state != 'ready':
                    return HttpResponse('Not Found', status=404)
                if str(staged.actor_id) != str(user.id):
                    canonical = '/api/media/'+original_key
                    published = (Asset.objects.filter(images__contains=[canonical]).exists()
                        or PortraitAsset.objects.filter(image_url=canonical).exists())
                    if not published:
                        return HttpResponse('Not Found', status=404)
        # ZIPs have per-owner access and expiry checks at the export endpoint.
        # The shared-library cookie route must not bypass either check.
        if is_export_key(key):
            return HttpResponse('Not Found', status=404)
    except InvalidMediaKey:
        return HttpResponse('Not Found',status=404)
    try:
        storage = get_storage()
        target, fresh = key, None
        width = _width(request.GET.get('w'))
        step = next((step for step in (512,1280) if width and step >= width), None) if is_thumbnailable(key) else None
        if step and settings.LOCAL_DATA_MODE != 'read_only_viewer':
            derivative = thumb_key(key,step)
            try:
                if storage.exists(derivative):
                    target = derivative
                else:
                    original = storage.open(key)
                    try:
                        if original.content_type.startswith('image/'):
                            fresh = thumbnail_bytes(b''.join(original.stream),step)
                            storage.primary.put(derivative,fresh,'image/webp','public, max-age=31536000, immutable')
                            target = derivative
                    finally:
                        original.stream.close()
            except MediaNotFoundError:
                raise
            except Exception:
                fresh = None
        direct = storage.browser_url(target) if request.GET.get('inline') != '1' else None
        if direct:
            return _redirect(direct,'private, max-age=21600')
        if fresh:
            response = HttpResponse(fresh,content_type='image/webp')
            response['Content-Length'] = str(len(fresh))
            response['Cache-Control'] = 'private, max-age=31536000, immutable'
            response['X-Content-Type-Options'] = 'nosniff'
            return response
        return _stream_response(storage.open(target,request.headers.get('Range')))
    except MediaNotFoundError:
        return HttpResponse('Not Found',status=404)
    except InvalidMediaRangeError:
        return HttpResponse('Range Not Satisfiable',status=416)
    except Exception:
        return HttpResponse('Internal Server Error',status=500)


@require_http_methods(['GET'])
def media_grant(request):
    key = verify_media_grant(request.GET.get('t'))
    if not key:
        return JsonResponse({'error':'INVALID_OR_EXPIRED_GRANT'},status=403)
    try:
        return _stream_response(get_storage().open(key,request.headers.get('Range')),cache='private, max-age=300')
    except MediaNotFoundError:
        return JsonResponse({'error':'NOT_FOUND'},status=404)
    except InvalidMediaRangeError:
        return JsonResponse({'error':'INVALID_RANGE'},status=416)
    except Exception:
        return JsonResponse({'error':'READ_FAILED'},status=500)


@require_http_methods(['POST'])
def upload_presign(request):
    user = lookup(request)
    body = _body(request)
    # Resolve storage only once valid authentication, purpose and MIME reach signing.
    status, result = create_upload_presign(str(user.id) if user else None,body.get('purpose'),
        body.get('contentType'),lambda key,mime:get_storage().signed_upload_url(key,mime))
    return JsonResponse(result,status=status)


def _upload_reply(request, callback):
    user = lookup(request)
    if not user:
        return JsonResponse({'error': 'UNAUTHENTICATED'}, status=401)
    try:
        result = callback(user)
        response = JsonResponse(result)
    except UploadError as error:
        response = JsonResponse({'error': error.code}, status=error.status)
    except Exception:
        response = JsonResponse({'error': 'UPLOAD_SERVICE_UNAVAILABLE'}, status=503)
    response['Cache-Control'] = 'private, no-store'
    return response


@require_http_methods(['POST'])
def upload_init(request):
    # These endpoints accept metadata only. Never route binary through JSON.
    if request.content_type != 'application/json':
        return JsonResponse({'error': 'UPLOAD_METADATA_JSON_REQUIRED'}, status=415)
    try:
        if int(request.headers.get('Content-Length', '0')) > 4096:
            return JsonResponse({'error': 'UPLOAD_METADATA_TOO_LARGE'}, status=413)
    except ValueError:
        return JsonResponse({'error': 'INVALID_CONTENT_LENGTH'}, status=400)
    return _upload_reply(request, lambda user: initialize_upload(user.id,
        _body(request), get_storage(), origin=request.headers.get('Origin')))


@require_http_methods(['GET'])
def upload_session_status(request, id):
    return _upload_reply(request, lambda user: upload_status(user.id, id, get_storage()))


@require_http_methods(['POST'])
def upload_finalize(request, id):
    return _upload_reply(request, lambda user: finalize_upload(user.id, id, get_storage()))


@require_http_methods(['POST'])
def upload_cancel(request, id):
    return _upload_reply(request, lambda user: cancel_upload(user.id, id, get_storage()))


@require_http_methods(['PUT'])
def local_resumable_upload(request, id):
    user = lookup(request)
    if not user:
        return JsonResponse({'error': 'UNAUTHENTICATED'}, status=401)
    try:
        status, offset = stream_local_chunk(user.id, id, request, get_storage())
        response = HttpResponse(status=status)
        if status == 308 and offset:
            response['Range'] = f'bytes=0-{offset-1}'
        response['Cache-Control'] = 'private, no-store'
        return response
    except UploadError as error:
        return JsonResponse({'error': error.code}, status=error.status)
    except Exception:
        return JsonResponse({'error': 'UPLOAD_SERVICE_UNAVAILABLE'}, status=503)


@require_http_methods(['PUT'])
def local_upload(request):
    token = verify_upload(request.GET.get('t'))
    if token is None:
        return JsonResponse({'error':'INVALID_OR_EXPIRED_GRANT'},status=403)
    storage = get_storage()
    if not isinstance(storage.primary,FileSystemAdapter):
        return HttpResponse(status=404)
    if request.headers.get('Content-Type') != token['type']:
        return JsonResponse({'error':'CONTENT_TYPE_MISMATCH'},status=400)
    maximum = getattr(settings,'VEEVEE_LOCAL_UPLOAD_MAX_BYTES',2*1024*1024*1024)
    try:
        if int(request.headers.get('Content-Length','0')) > maximum:
            return JsonResponse({'error':'UPLOAD_TOO_LARGE'},status=413)
    except ValueError:
        return JsonResponse({'error':'INVALID_CONTENT_LENGTH'},status=400)
    # Local direct uploads emulate cloud PUT without Django's in-memory body
    # parser; video references can exceed the JSON/multipart request ceiling.
    with tempfile.TemporaryFile() as incoming:
        total = 0
        while chunk := request.read(256*1024):
            total += len(chunk)
            if total > maximum:
                return JsonResponse({'error':'UPLOAD_TOO_LARGE'},status=413)
            incoming.write(chunk)
        incoming.seek(0)
        storage.primary.put_stream(token['key'],incoming,token['type'],'private, no-store')
    return HttpResponse(status=200)


@require_http_methods(['GET','HEAD'])
def generation_download(request,id):
    if not lookup(request):
        return JsonResponse({'error':'UNAUTHENTICATED'},status=401)
    if not id:
        return JsonResponse({'error':'INVALID_GENERATION_ID'},status=400)
    try:
        generation = Generation.objects.filter(id=id).first()
    except (ValidationError,ValueError):
        generation = None
    if not generation:
        return JsonResponse({'error':'GENERATION_NOT_FOUND'},status=404)
    if generation.status in ('pending','running'):
        return JsonResponse({'error':'GENERATION_PROCESSING','message':'Generation is still processing.'},status=409)
    if generation.status == 'failed':
        return JsonResponse({'error':'GENERATION_FAILED','message':'Cannot download a failed generation.'},status=409)
    if not generation.url:
        return JsonResponse({'error':'MEDIA_NOT_FOUND','message':'Generation has no media output.'},status=404)
    key = media_key_from_ref(generation.url,getattr(settings,'GCP_MEDIA_CDN_URL',''))
    if not key or is_export_key(key):
        return JsonResponse({'error':'MEDIA_NOT_FOUND','message':'Media key is unavailable or protected.'},status=404)
    resolved = batch_resolve_generation_filenames([generation.id]).get(str(generation.id),{})
    filename = resolved.get('filename') or f'{generation.id}.bin'
    fallback = re.sub(r'[^\x20-\x7E]','_',filename).replace('"','').replace('\\','')
    disposition = f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(filename,safe="!~*\'()")}'
    storage = get_storage()
    if (request.GET.get('signed') == '1' or request.GET.get('redirect') == '1') and not request.headers.get('Range'):
        try:
            signed = storage.signed_download_url(key,filename,disposition)
            if signed:
                return _redirect(signed)
        except Exception:
            pass
    try:
        return _stream_response(storage.open(key,request.headers.get('Range')),head=request.method == 'HEAD',
            cache='private, no-cache, no-store, must-revalidate',disposition=disposition)
    except MediaNotFoundError:
        return JsonResponse({'error':'MEDIA_NOT_FOUND'},status=404)
    except InvalidMediaRangeError:
        return HttpResponse('Range Not Satisfiable',status=416)
    except Exception:
        return JsonResponse({'error':'INTERNAL_ERROR'},status=500)
