"""Strict Magnific input boundary before any billable submission."""
import base64
import io
import math
import re
from urllib.parse import urljoin, urlsplit
from PIL import Image
from apps.common.javascript import string, utf16_length
from apps.generation.providers.magnific import MODELS, PRESETS, ENGINES

MAX_BYTES = 20*1024*1024
MAX_PIXELS = 40000000
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
MIMES = ('image/jpeg', 'image/png', 'image/webp')
SCALES = ('2x', '4x', '8x', '16x')


class InvalidUpscaleRequest(ValueError):
    pass


def fail(message):
    raise InvalidUpscaleRequest(message)


def validate_upscale_request(body):
    body = body if isinstance(body, dict) else {}
    model = body.get('model')
    if model not in MODELS: fail('Unsupported upscale model.')
    if not isinstance(body.get('image'), str) or not body['image']: fail('Source image is required for upscaling.')
    for key in ('projectId', 'folderId'):
        if body.get(key) is not None and not UUID.fullmatch(string(body[key])): fail(f'Invalid {key}.')
    params = body.get('params')
    if not isinstance(params, dict): fail('Invalid upscale parameters.')
    allowed = ['model', 'filterNsfw'] + (
        ['scaleFactor','optimizedFor','engine','creativity','hdr','resemblance','fractality','prompt'] if model == 'Magnific Creative' else
        ['scaleFactor','flavor','sharpen','smartGrain','ultraDetail'] if model == 'Magnific Precision V2' else ['sharpen','smartGrain','ultraDetail'])
    for key in params:
        if key not in allowed: fail(f'Parameter {key} is not supported by {model}.')
    if params.get('model') is not None and params['model'] != model: fail('Parameter model does not match model.')
    if params.get('prompt') is not None and (not isinstance(params['prompt'], str) or utf16_length(params['prompt']) > 2000): fail('Prompt must be 2000 characters or fewer.')
    if params.get('filterNsfw') is not None and type(params['filterNsfw']) is not bool: fail('filterNsfw must be boolean.')
    def numeric(key, minimum, maximum):
        value = params.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
            fail(f'{key} must be between {minimum} and {maximum}.')
    if model == 'Magnific Creative':
        if params.get('scaleFactor') not in SCALES: fail('Invalid scaleFactor.')
        if params.get('optimizedFor') not in PRESETS: fail('Invalid optimizedFor preset.')
        if params.get('engine') not in ENGINES: fail('Invalid engine.')
        for key in ('creativity','hdr','resemblance','fractality'): numeric(key, -10, 10)
    else:
        for key in ('sharpen','smartGrain','ultraDetail'): numeric(key, 0, 100)
        if model == 'Magnific Precision V2':
            if params.get('scaleFactor') not in SCALES: fail('Invalid scaleFactor.')
            if params.get('flavor') not in ('photo','sublime','photo_denoiser'): fail('Invalid flavor.')
    return body


def validate_source(value, origin):
    if value.startswith('data:'): return
    try:
        # WHATWG treats backslashes as slashes for HTTP special schemes.
        parsed = urlsplit(urljoin(origin+'/', value.replace('\\', '/')))
        base = urlsplit(origin)
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        base_port = base.port or (443 if base.scheme == 'https' else 80)
        same = (parsed.scheme, parsed.hostname, port) == (base.scheme, base.hostname, base_port)
    except ValueError:
        fail('Invalid source image URL.')
    if not same or not parsed.path.startswith('/api/media/'): fail('Source image must be uploaded to this application.')


def inspect_image(data, declared_mime):
    try:
        decoded = base64.b64decode(data)
    except (ValueError, TypeError):
        fail('Source is not a valid supported image.')
    if len(decoded) > MAX_BYTES: fail('Source image must be 20 MB or smaller.')
    if string(declared_mime).lower() not in MIMES: fail('Source must be a JPEG, PNG, or WebP image.')
    try:
        image = Image.open(io.BytesIO(decoded))
        # Sharp's limitInputPixels fails in metadata before the explicit gate.
        if image.width*image.height > MAX_PIXELS: raise ValueError()
    except Exception:
        fail('Source is not a valid supported image.')
    with image:
        if not image.width or not image.height: fail('Source image exceeds the 40 megapixel limit.')
        detected = 'image/' + ('jpeg' if image.format == 'JPEG' else (image.format or '').lower())
        if detected not in MIMES or detected != declared_mime.lower(): fail('Source image type does not match its contents.')
        return {'buffer': decoded, 'meta': {'width': image.width, 'height': image.height}}


def aspect_ratio(width, height):
    if not width or not height: return '1:1'
    ratios = ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9']
    distances = [abs(width/height-int(label.split(':')[0])/int(label.split(':')[1])) for label in ratios]
    index = distances.index(min(distances))
    return ratios[index] if distances[index] < .08 else f'{width}:{height}'


def validate_output_area(model, params, meta):
    # The Creative endpoint documents a 25.3M-pixel output maximum. Do not
    # silently reduce scale/source quality or spend on a known invalid request.
    if model == 'Magnific Creative':
        scale = int(params['scaleFactor'][:-1])
        if meta['width'] * meta['height'] * scale * scale > 25300000:
            fail('Magnific Creative output cannot exceed 25.3 megapixels. Choose a smaller scale or source image.')


# Video upscaling. Magnific publishes no input limits; these bound spend and
# worker time, and match the video-reference upload cap.
from apps.generation.providers.magnific import (VIDEO_MODELS, VIDEO_PARAMS, VIDEO_RESOLUTIONS, VIDEO_FLAVORS,
                                                 VIDEO_OUTPUT_FORMATS, TOPAZ_MODELS, TOPAZ_INTERPOLATIONS)
MAX_VIDEO_SECONDS = 60
MAX_VIDEO_FPS = 60
MAX_VIDEO_BYTES = 2*1024*1024*1024
VIDEO_SOURCE_PREFIXES = ('uploads/', 'generations/', 'references/')


def validate_video_upscale_request(body):
    body = body if isinstance(body, dict) else {}
    model = body.get('model')
    if model not in VIDEO_MODELS: fail('Unsupported video upscale model.')
    if not isinstance(body.get('video'), str) or not body['video']: fail('Source video is required for upscaling.')
    for key in ('projectId', 'folderId'):
        if body.get(key) is not None and not UUID.fullmatch(string(body[key])): fail(f'Invalid {key}.')
    params = body.get('params')
    if not isinstance(params, dict): fail('Invalid upscale parameters.')
    for key in params:
        if key != 'model' and key not in VIDEO_PARAMS[model]: fail(f'Parameter {key} is not supported by {model}.')
    if params.get('model') is not None and params['model'] != model: fail('Parameter model does not match model.')
    def integer(key, minimum, maximum, required=True):
        value = params.get(key)
        if value is None and not required: return
        # JSON bodies are parsed with JavaScript number semantics (0 may be 0.0).
        if type(value) not in (int, float) or not math.isfinite(value) or value != int(value) or not minimum <= value <= maximum:
            fail(f'{key} must be a whole number between {minimum} and {maximum}.')
    if params.get('resolution') not in VIDEO_RESOLUTIONS: fail('Invalid resolution.')
    if model == 'Magnific Video Topaz':
        if params.get('enhancementModel') not in TOPAZ_MODELS: fail('Invalid enhancementModel.')
        # Docs: target_fps is 1-60, but interpolation (applied whenever it changes
        # the rate) requires at least 15; frame_interpolation needs a target.
        integer('targetFps', 15, 60, required=False)
        if params.get('frameInterpolation') is not None and params.get('targetFps') is None: fail('frameInterpolation requires targetFps.')
        if params.get('frameInterpolation', 'apollo') not in TOPAZ_INTERPOLATIONS: fail('Invalid frameInterpolation.')
        noise = params.get('noise')
        if type(noise) not in (int, float) or not math.isfinite(noise) or not 0 <= noise <= 1: fail('noise must be between 0 and 1.')
        return body
    for key in ('sharpen', 'smartGrain') + (('strength',) if model == 'Magnific Video Precision' else ('creativity',)):
        integer(key, 0, 100)
    if type(params.get('fpsBoost')) is not bool: fail('fpsBoost must be boolean.')
    if model != 'Magnific Video Precision' and params.get('flavor') not in VIDEO_FLAVORS: fail('Invalid flavor.')
    if params.get('outputFormat') not in VIDEO_OUTPUT_FORMATS: fail('Invalid outputFormat.')
    return body


def video_source_key(ref):
    """Only immutable stored media may be upscaled; never exports or foreign URLs."""
    from django.conf import settings
    from apps.media.keys import media_key_from_ref, is_export_key
    key = media_key_from_ref(ref, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
    if not key or is_export_key(key) or not key.startswith(VIDEO_SOURCE_PREFIXES) or '?' in ref or '#' in ref:
        fail('Source video must be uploaded to this application.')
    return key


def _fraction(value):
    match = re.fullmatch(r'([0-9]+)/([0-9]+)', string(value))
    if match and int(match[2]):
        return int(match[1]) / int(match[2])
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def inspect_video_source(ref, *, actor_id=None, storage=None, run=None):
    """Bounded ffprobe of a stored video (local file or short-lived signed read)."""
    import json
    import subprocess
    from django.conf import settings
    from apps.media.storage import get_storage, FileSystemAdapter
    key = video_source_key(ref)
    storage = storage or get_storage()
    primary = getattr(storage, 'primary', None)
    if isinstance(primary, FileSystemAdapter) and primary._path(key).exists():
        target = str(primary._path(key))
    else:
        target = storage.signed_read_url(key, 600, actor_id=actor_id)
    # Only the MOV/MP4 and Matroska/WebM demuxers (FFmpeg format_whitelist), so a
    # stored playlist-type file can never make ffprobe open further connections.
    command = [getattr(settings, 'FFPROBE_BINARY', 'ffprobe'), '-v', 'error', '-protocol_whitelist', 'file,https,tls,tcp,crypto',
               '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
               '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,duration:format=duration,size,format_name',
               '-of', 'json', target]
    try:
        result = (run or subprocess.run)(command, capture_output=True, timeout=15, check=True)
        data = json.loads(result.stdout)
    except Exception:
        fail('Source is not a readable video.')
    video = next((stream for stream in data.get('streams') or [] if stream.get('codec_type') == 'video'), None)
    if not video or not video.get('width') or not video.get('height'): fail('Source is not a readable video.')
    duration = _fraction((data.get('format') or {}).get('duration') or video.get('duration'))
    fps = _fraction(video.get('avg_frame_rate')) or _fraction(video.get('r_frame_rate'))
    size = int(_fraction((data.get('format') or {}).get('size')))
    if not duration > 0 or not fps > 0: fail('Source video duration or frame rate could not be read.')
    if duration > MAX_VIDEO_SECONDS: fail(f'Source video must be {MAX_VIDEO_SECONDS} seconds or shorter.')
    if fps > MAX_VIDEO_FPS + .5: fail(f'Source video must be {MAX_VIDEO_FPS} fps or lower.')
    if size > MAX_VIDEO_BYTES: fail('Source video must be 2 GB or smaller.')
    return {'durationSeconds': round(duration, 3), 'fps': round(fps, 3), 'width': int(video['width']),
            'height': int(video['height']), 'bytes': size, 'codec': video.get('codec_name')}


VIDEO_RESOLUTION_RATES = {'720p': 7/9, '1k': 7/9, '2k': 1, '4k': 12/9}


def video_upscale_frames(model, params, meta):
    """Frames Magnific bills: output fps x duration, 1.6x with fps_boost, minimum 12."""
    fps = params.get('targetFps') if model == 'Magnific Video Topaz' and params.get('targetFps') else meta['fps']
    frames = math.ceil(meta['durationSeconds'] * fps)
    if params.get('fpsBoost') is True:
        frames = math.ceil(frames * 1.6)
    return max(12, frames)


def video_upscale_cost(model, params, meta, pricing):
    row = next((row for row in pricing if row['model'] == model), None)
    if not row or row.get('unit') != 'per_1000_frames' or type(row.get('unitCostCents')) is not int:
        raise ValueError(f'Pricing is not configured for {model}.')
    frames = video_upscale_frames(model, params, meta)
    return math.ceil(frames * row['unitCostCents'] / 1000 * VIDEO_RESOLUTION_RATES[params['resolution']])


# ProRes 422 HQ masters are large and Veevee stores masters up to 4 GB within one
# worker budget. Apple: "approximately 220 Mbps at 1920x1080 and 29.97 fps"
# (support.apple.com/en-us/102207); data rate grows with frame size and rate, so
# this scales it by pixel rate. Magnific documents only the resolution labels, so
# the output long edges below are conservative assumptions, not provider facts.
PRORES_HQ_BITS_PER_PIXEL = 220e6 / (1920 * 1080 * 29.97)
OUTPUT_LONG_EDGE = {'720p': 1280, '1k': 2048, '2k': 2560, '4k': 3840}
MAX_PRORES_MASTER_BYTES = int(3.5 * 1024 ** 3)


def estimated_prores_bytes(params, meta):
    long_edge = OUTPUT_LONG_EDGE[params['resolution']]
    ratio = min(meta['width'], meta['height']) / max(meta['width'], meta['height'])
    pixels = long_edge * long_edge * ratio
    frames = meta['durationSeconds'] * meta['fps'] * (1.6 if params.get('fpsBoost') is True else 1)
    return pixels * frames * PRORES_HQ_BITS_PER_PIXEL / 8


def validate_prores_size(model, params, meta):
    if model == 'Magnific Video Topaz' or params.get('outputFormat') != 'prores_422_hq':
        return
    if estimated_prores_bytes(params, meta) > MAX_PRORES_MASTER_BYTES:
        fail('A ProRes 422 HQ master at this resolution and length would exceed the 4 GB Veevee can store. '
             'Choose H.264, a lower resolution or a shorter clip.')
