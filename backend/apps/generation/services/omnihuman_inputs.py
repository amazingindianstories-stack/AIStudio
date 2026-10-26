"""Validate original OmniHuman input bytes before queueing and again before payment."""
import io
import json
import math
import shutil
import subprocess
import tempfile

from PIL import Image
from apps.generation.providers import omnihuman
from apps.media.audio_duration import PROBE_TIMEOUT_SECONDS
from apps.media.storage import get_storage

IMAGE_BYTES = 30 * 1024 * 1024
AUDIO_BYTES = 15 * 1024 * 1024
IMAGE_FORMATS = frozenset(('JPEG', 'PNG', 'WEBP', 'BMP', 'TIFF', 'GIF', 'HEIF', 'HEIC'))


def audio_seconds(data):
    """Probe the actual WAV/MP3 container and audio stream as well as its duration."""
    probe = shutil.which('ffprobe')
    if not probe:
        return None
    with tempfile.NamedTemporaryFile(suffix='.audio') as handle:
        handle.write(data)
        handle.flush()
        result = subprocess.run([probe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-show_entries', 'format=format_name,duration:stream=codec_type:stream_disposition=attached_pic', '-of', 'json', handle.name],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS, check=True)
    metadata = json.loads(result.stdout)
    if metadata.get('format', {}).get('format_name') not in ('wav', 'mp3'):
        return None
    streams = metadata.get('streams', [])
    if sum(stream.get('codec_type') == 'audio' for stream in streams) != 1:
        return None
    if any(stream.get('codec_type') != 'audio' and not stream.get('disposition', {}).get('attached_pic') for stream in streams):
        return None
    return float(metadata['format']['duration'])


def validate(images, audios, *, read=None, measure=audio_seconds):
    if len(images) != 1 or len(audios) != 1:
        raise ValueError(omnihuman.INVALID)
    if isinstance(audios[0], str) and audios[0].startswith('data:'):
        raise ValueError(omnihuman.AUDIO)
    read = read or get_storage().read_reference_bytes
    try:
        original = read(images[0].split('#', 1)[0], max_bytes=IMAGE_BYTES - 1)
        data = original['bytes']
        if not data or len(data) >= IMAGE_BYTES:
            raise ValueError('size')
        # Register HEIF through the same optional decoder used by media ingestion.
        import pillow_heif
        pillow_heif.register_heif_opener()
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if image.format not in IMAGE_FORMATS or not (300 <= width <= 6000 and 300 <= height <= 6000 and .4 <= width / height <= 2.5):
                raise ValueError('dimensions or format')
            image.load()
    except Exception:
        raise ValueError(omnihuman.IMAGE) from None
    try:
        original = read(audios[0], max_bytes=AUDIO_BYTES - 1)
        data = original['bytes']
        # Inspect the container, not an untrusted filename or browser MIME type.
        wav = data.startswith(b'RIFF') and data[8:12] == b'WAVE'
        mp3 = data.startswith(b'ID3') or len(data) > 1 and data[0] == 0xff and data[1] & 0xe0 == 0xe0
        if not data or len(data) >= AUDIO_BYTES or not (wav or mp3):
            raise ValueError('format or size')
        seconds = measure(data)
        if seconds is None or not math.isfinite(seconds) or not 4 <= seconds <= 300:
            raise ValueError('duration')
    except Exception:
        raise ValueError(omnihuman.AUDIO) from None
    return seconds
