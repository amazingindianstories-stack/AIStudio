"""Persist provider results exactly once; metadata/preview failures never lose masters."""
import base64
import io
import math
import re
import subprocess
import tempfile
import shutil
from urllib.parse import quote
from pathlib import Path
from django.conf import settings
from .storage import get_storage
from apps.integrations.remote import get_media_fetcher, SafeMediaFetcher

DEFAULT_RATIOS = {'image':['1:1','3:4','4:3','9:16','16:9','21:9'],
                  'video':['16:9','9:16','1:1','4:3','3:4','21:9']}


def nearest_supported_aspect_ratio(width,height,ratios):
    if not all(isinstance(value,(int,float)) and math.isfinite(value) and value > 0 for value in (width,height)):
        return None
    target = math.log(width/height)
    best,delta = None,math.inf
    for label in ratios or []:
        match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?):([0-9]+(?:\.[0-9]+)?)',str(label))
        if not match:
            continue
        w,h = map(float,match.groups())
        if w <= 0 or h <= 0:
            continue
        distance = abs(math.log(w/h)-target)
        if distance < delta:
            best,delta = label,distance
    return best


def inspect_image_dimensions(data):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        if image.width*image.height > 100_000_000:
            raise ValueError('Image exceeds pixel limit.')
        width,height = image.size
        if image.getexif().get(274) in (5,6,7,8):
            width,height = height,width
        return width,height


def _run_ffmpeg(arguments,timeout=30):
    binary = getattr(settings,'FFMPEG_BINARY','ffmpeg')
    result = subprocess.run([binary,'-nostdin','-hide_banner',*arguments],
        capture_output=True,timeout=timeout,check=True)
    return result.stdout,result.stderr


def inspect_video_dimensions(data,ext='mp4'):
    with tempfile.TemporaryDirectory(prefix='veevee-media-metadata-') as directory:
        source = Path(directory)/('input.'+re.sub('[^a-z0-9]','',ext.lower()))
        source.write_bytes(data)
        _,output = _run_ffmpeg(['-protocol_whitelist','file,pipe','-i',str(source),'-map','0:v:0',
            '-frames:v','1','-vf','showinfo','-f','null','-'])
        text = output.decode(errors='replace')
        match = re.search(r'\bs:([0-9]{1,6})x([0-9]{1,6})\b',text) or re.search(r'Video:[^\n]*?\b([0-9]{2,6})x([0-9]{2,6})\b',text)
        if not match:
            raise ValueError('ffmpeg did not report video dimensions.')
        return int(match[1]),int(match[2])


def measure_generated_media(data,ext,metadata=None):
    metadata = metadata or {}
    kind = metadata.get('kind','image')
    requested = metadata.get('requestedAspectRatio',metadata.get('requested_aspect_ratio'))
    try:
        width,height = inspect_video_dimensions(data,ext) if kind == 'video' else inspect_image_dimensions(data)
        ratios = metadata.get('supportedRatios') or DEFAULT_RATIOS.get(kind,[])
        aspect = nearest_supported_aspect_ratio(width,height,ratios)
        if not aspect:
            raise ValueError('No supported aspect ratio could be selected.')
        return {'width':width,'height':height,'aspectRatio':aspect}
    except Exception:
        return {'aspectRatio':requested}


def _native_container(data,ext):
    if ext != 'mov':
        return
    # ftyp can follow a free/wide atom. A compatible qt brand on an MP4 major
    # brand is not proof of a native MOV master. Legacy QuickTime may omit
    # ftyp; require actual container atoms rather than accepting arbitrary data.
    offset, legacy = 0, False
    while offset + 8 <= len(data):
        size = int.from_bytes(data[offset:offset+4], 'big')
        kind = data[offset+4:offset+8]
        header = 8
        if size == 1:
            if offset + 16 > len(data):
                break
            size, header = int.from_bytes(data[offset+8:offset+16], 'big'), 16
        if size == 0:
            size = len(data) - offset
        if size < header or offset + size > len(data):
            break
        if kind == b'ftyp':
            if size >= header + 8 and data[offset+header:offset+header+4] == b'qt  ':
                return
            raise ValueError('Provider returned a non-MOV container for native MOV output.')
        legacy = legacy or kind in (b'moov', b'mdat')
        offset += size
    if not legacy:
        raise ValueError('Provider returned a non-MOV container for native MOV output.')


def save_buffer_with_metadata(data,ext,identifier,metadata=None):
    if ext not in ('png','jpg','jpeg','webp','gif','avif','mov','mp4','webm','mp3','wav'):
        raise ValueError('Unsupported generated media format.')
    _native_container(data,ext)
    url = get_storage().upload_buffer(data,f'generations/{identifier}.{ext}',ext)
    return {'url':url,**measure_generated_media(data,ext,metadata)}


def save_base64_with_metadata(data,ext,identifier,metadata=None):
    return save_buffer_with_metadata(base64.b64decode(data,validate=True),ext,identifier,metadata)


def save_from_url_with_metadata(url,ext,identifier,metadata=None,fetcher=None):
    fetch = fetcher or get_media_fetcher()
    if ext in ('mov','mp4','webm') and isinstance(fetch, SafeMediaFetcher):
        with fetch.open_file(url) as (stream, _):
            return save_video_stream_with_metadata(stream, ext, identifier, metadata)
    data,_ = fetch(url)
    return save_buffer_with_metadata(data,ext,identifier,metadata)


def save_video_stream_with_metadata(stream, ext, identifier, metadata=None):
    """Persist a spooled original video without decoding or re-encoding its master."""
    result = _save_video_stream(stream, ext, identifier)
    requested = (metadata or {}).get('requestedAspectRatio', (metadata or {}).get('requested_aspect_ratio'))
    try:
        with tempfile.TemporaryDirectory(prefix='veevee-media-metadata-') as directory:
            source = Path(directory)/('input.'+ext)
            stream.seek(0)
            with source.open('wb') as output:
                shutil.copyfileobj(stream, output, 256*1024)
            _, output = _run_ffmpeg(['-protocol_whitelist','file,pipe','-i',str(source),'-map','0:v:0',
                '-frames:v','1','-vf','showinfo','-f','null','-'])
            text = output.decode(errors='replace')
            match = re.search(r'\bs:([0-9]{1,6})x([0-9]{1,6})\b',text) or re.search(r'Video:[^\n]*?\b([0-9]{2,6})x([0-9]{2,6})\b',text)
            width,height = int(match[1]),int(match[2])
            aspect = nearest_supported_aspect_ratio(width,height,(metadata or {}).get('supportedRatios') or DEFAULT_RATIOS['video'])
            if not aspect: raise ValueError('No supported aspect ratio.')
            return {'url':result,'width':width,'height':height,'aspectRatio':aspect}
    except Exception:
        return {'url':result,'aspectRatio':requested}


def _save_video_stream(stream, ext, identifier):
    if ext == 'mov':
        stream.seek(0, 2)
        length = stream.tell()
        offset, legacy = 0, False
        while offset + 8 <= length:
            stream.seek(offset)
            header = stream.read(8)
            size,kind = int.from_bytes(header[:4],'big'),header[4:]
            header_size = 8
            if size == 1:
                extended = stream.read(8)
                if len(extended) != 8: break
                size,header_size = int.from_bytes(extended,'big'),16
            if size == 0: size = length-offset
            if size < header_size or offset+size > length: break
            if kind == b'ftyp':
                if size < header_size+8 or stream.read(4) != b'qt  ':
                    raise ValueError('Provider returned a non-MOV container for native MOV output.')
                legacy = True
                break
            legacy = legacy or kind in (b'moov',b'mdat')
            offset += size
        if not legacy:
            raise ValueError('Provider returned a non-MOV container for native MOV output.')
    stream.seek(0)
    from .storage import MIME
    key = f'generations/{identifier}.{ext}'
    get_storage().upload_stream(stream,key,MIME[ext],'public, max-age=31536000, immutable')
    return '/api/media/'+quote(key,safe='/')


def save_base64(data,ext,identifier):
    decoded = base64.b64decode(data,validate=True)
    _native_container(decoded,ext)
    return get_storage().upload_buffer(decoded,f'generations/{identifier}.{ext}',ext)


def save_from_url(url,ext,identifier,fetcher=None):
    fetch = fetcher or get_media_fetcher()
    if ext in ('mov','mp4','webm') and isinstance(fetch, SafeMediaFetcher):
        with fetch.open_file(url) as (stream, _):
            return _save_video_stream(stream,ext,identifier)
    data,_ = fetch(url)
    _native_container(data,ext)
    return get_storage().upload_buffer(data,f'generations/{identifier}.{ext}',ext)


def extract_last_frame(data):
    with tempfile.TemporaryDirectory(prefix='veevee-video-frame-') as directory:
        source,output = Path(directory)/'input.video',Path(directory)/'frame.jpg'
        source.write_bytes(data)
        _run_ffmpeg(['-y','-protocol_whitelist','file,pipe','-sseof','-1','-i',str(source),
                     '-frames:v','1','-q:v','3',str(output)],timeout=60)
        return {'mimeType':'image/jpeg','data':base64.b64encode(output.read_bytes()).decode()}


def extract_last_frame_server(url,fetcher=None):
    fetch = fetcher or get_media_fetcher()
    if isinstance(fetch, SafeMediaFetcher):
        with fetch.open_file(url) as (stream, _), tempfile.TemporaryDirectory(prefix='veevee-video-frame-') as directory:
            source,output = Path(directory)/'input.video',Path(directory)/'frame.jpg'
            with source.open('wb') as incoming:
                shutil.copyfileobj(stream,incoming,256*1024)
            _run_ffmpeg(['-y','-protocol_whitelist','file,pipe','-sseof','-1','-i',str(source),
                        '-frames:v','1','-q:v','3',str(output)],timeout=60)
            return {'mimeType':'image/jpeg','data':base64.b64encode(output.read_bytes()).decode()}
    data,_ = fetch(url)
    return extract_last_frame(data)
