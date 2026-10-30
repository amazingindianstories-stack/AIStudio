"""Video bounds for a Gallery video portrait (the asset library's documented video rules).

MP4 or MOV, 2-30 seconds, 24-60 fps, each side 300-6000 px, aspect ratio 0.4-2.5, 407,696-8,295,044 total pixels and at
most 200 MB. Probed with ffprobe from the stored object (a local path or a short signed URL read with HTTP ranges);
the master is never read into memory or rewritten.
Source: BytePlus ModelArk "Add real-human assets to asset library" (video format requirements).
"""
import json
import subprocess
import shutil
from fractions import Fraction

from apps.generation import image_limits

MIN_SECONDS, MAX_SECONDS = 2, 30
MIN_FPS, MAX_FPS = 24, 60
MIN_PIXELS, MAX_PIXELS = 407696, 8295044
MAX_BYTES = 200 * 1024 * 1024
CONTAINERS = ('mp4', 'mov')
CONTENT_TYPES = ('video/mp4', 'video/quicktime')
PROBE_SECONDS = 20


def _fps(stream):
    for field in ('avg_frame_rate', 'r_frame_rate'):
        try:
            value = Fraction(stream.get(field) or '0/1')
        except (ValueError, ZeroDivisionError):
            continue
        if value > 0:
            return float(value)
    return 0.0


def parse(output):
    """Facts from `ffprobe -print_format json -show_format -show_streams`, or None when there is no readable video stream."""
    try:
        data = json.loads(output)
        streams = [s for s in data.get('streams') or [] if s.get('codec_type') == 'video' and not (s.get('disposition') or {}).get('attached_pic')]
        stream, container = streams[0], str((data.get('format') or {}).get('format_name') or '')
        width, height = int(stream['width']), int(stream['height'])
        rotation = abs(int(float(next((d.get('rotation') for d in stream.get('side_data_list') or [] if 'rotation' in d), (stream.get('tags') or {}).get('rotate') or 0)))) % 180
        seconds = float(stream.get('duration') or (data.get('format') or {}).get('duration') or 0)
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        return None
    if rotation == 90:
        width, height = height, width
    return {'containers': container.split(','), 'width': width, 'height': height, 'seconds': seconds, 'fps': _fps(stream)}


def probe(source, protocols='file'):
    """Facts about the video at `source` (path or https URL), or None when ffprobe cannot read it. Never raises."""
    binary = shutil.which('ffprobe')
    if not binary:
        return None
    try:
        result = subprocess.run([binary, '-v', 'error', '-protocol_whitelist', protocols, '-print_format', 'json', '-show_format', '-show_streams', source],
                                capture_output=True, text=True, timeout=PROBE_SECONDS, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse(result.stdout)


def probe_stored(storage, key):
    from apps.media.posters import _source
    source, protocols = _source(storage, key)
    return probe(source, protocols) if source else None


def problem(info):
    """(code, short user copy) for the first rule a video breaks, else None. The copy fits under a card's file name."""
    if info is None:
        return 'PORTRAIT_VIDEO_UNREADABLE', 'This video could not be read. Use an MP4 or MOV file and upload it again.'
    if not set(info['containers']) & set(CONTAINERS):
        return 'PORTRAIT_VIDEO_FORMAT', 'Only MP4 and MOV videos can be portraits.'
    seconds = info['seconds']
    if seconds < MIN_SECONDS:
        return 'PORTRAIT_VIDEO_DURATION', f'Too short ({seconds:.1f} s). Use a clip of {MIN_SECONDS} to {MAX_SECONDS} seconds.'
    if seconds > MAX_SECONDS:
        return 'PORTRAIT_VIDEO_DURATION', f'Too long ({seconds:.0f} s). Use a clip of {MIN_SECONDS} to {MAX_SECONDS} seconds.'
    width, height = info['width'], info['height']
    size = f'{width} x {height} px'
    if min(width, height) < image_limits.MIN_SIDE or width * height < MIN_PIXELS:
        return 'PORTRAIT_VIDEO_SIZE', f'Too small ({size}). Use at least {image_limits.MIN_SIDE} px on each side.'
    if max(width, height) > image_limits.MAX_SIDE or width * height > MAX_PIXELS:
        return 'PORTRAIT_VIDEO_SIZE', f'Too large ({size}). Use 4K or smaller.'
    ratio = width / height
    if ratio > image_limits.MAX_RATIO:
        return 'PORTRAIT_VIDEO_RATIO', f'Too wide ({size}). Crop it closer to the face.'
    if ratio < image_limits.MIN_RATIO:
        return 'PORTRAIT_VIDEO_RATIO', f'Too tall ({size}). Crop it closer to the face.'
    fps = info['fps']
    if fps < MIN_FPS - .5 or fps > MAX_FPS + .5:
        return 'PORTRAIT_VIDEO_FPS', f'Frame rate is {fps:.0f} fps. Use {MIN_FPS} to {MAX_FPS} fps.'
    return None
