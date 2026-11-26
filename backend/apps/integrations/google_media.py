"""Vertex media handoff. Originals stay untouched; inference copies live only for one request.

The small inline budgets are Veevee's, below Google's limits (docs/providers/vertex-ai.md).
Run after request authorization, before network submission. Never handles the Gemini Files API.
"""
import base64
from contextlib import contextmanager
import copy
import io
import json
import logging
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
from uuid import uuid4

from .errors import ProviderError

MB = 1024 ** 2
INLINE_BYTES = 4 * MB
INLINE_TOTAL = 9 * MB
URI_BYTES = 2 * 1024 ** 3 - 500 * 1024
AI_INPUTS = 'ai-inputs/'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
DEMUXERS = {
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/x-aac': 'aac',
    'audio/mp4': 'mov', 'audio/m4a': 'mov', 'audio/x-m4a': 'mov', 'audio/webm': 'matroska',
    'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska',
    'video/mpeg': 'mpeg', 'video/mpg': 'mpeg', 'video/x-flv': 'flv', 'video/wmv': 'asf', 'video/3gpp': 'mov',
}
logger = logging.getLogger(__name__)


def vertex_endpoint(url):
    parsed = urlsplit(url)
    host = parsed.hostname or ''
    return (parsed.scheme == 'https' and not parsed.username and not parsed.password
            and (host == 'aiplatform.googleapis.com' or host.endswith('-aiplatform.googleapis.com'))
            and '/publishers/google/models/' in parsed.path and parsed.path.endswith(':generateContent'))


def staging_failed():
    return ProviderError('Veevee could not stage this file for AI reading. Try again in a minute.',
                         code='media_staging', may_have_submitted=False)


def unusable():
    return ProviderError('This file could not be prepared for AI reading. Use a smaller or re-exported copy.',
                         code='media_preparation', may_have_submitted=False)


def shrink(mime, data, budget, signal=None):
    """An inference derivative within budget, preserving the entire timeline. Never changes a master."""
    if signal:
        signal.check()
    if mime.startswith('image/'):
        from PIL import Image, ImageOps
        try:
            with Image.open(io.BytesIO(data)) as source:
                image = ImageOps.exif_transpose(source).convert('RGB')
                for edge in (4096, 3072, 2048, 1536, 1024, 768, 512):
                    if signal:
                        signal.check()
                    image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                    for quality in (92, 80, 65):
                        output = io.BytesIO()
                        image.save(output, format='JPEG', quality=quality)
                        if output.tell() <= budget:
                            return 'image/jpeg', output.getvalue()
        except (OSError, ValueError, Image.DecompressionBombError):
            raise unusable() from None
        raise unusable()
    if mime not in DEMUXERS:
        raise unusable()
    # Force the MIME's demuxer: an uploaded playlist must never open arbitrary local files.
    # Bounded local subprocesses; no silent truncation with -fs or -t.
    timeout = min(120, signal.remaining()) if signal else 120
    try:
        with tempfile.TemporaryDirectory(prefix='veevee-ai-media-') as directory:
            source = Path(directory) / 'input'
            source.write_bytes(data)
            probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                '-f', DEMUXERS[mime], '-show_entries', 'format=duration', '-of', 'json', str(source)],
                capture_output=True, check=True, timeout=min(15, timeout))
            seconds = float(json.loads(probe.stdout)['format']['duration'])
            if not 0 < seconds < 86400:
                raise unusable()
            rate = int(budget * 8 * .85 / seconds)
            video = mime.startswith('video/')
            if rate < (128000 if video else 24000):
                raise unusable()
            target = Path(directory) / ('output.mp4' if video else 'output.m4a')
            args = (['-map', '0:v:0', '-map', '0:a:0?', '-vf',
                     "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                     '-c:v', 'libx264', '-preset', 'fast', '-b:v', str(min(rate - 64000, 2000000)),
                     '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64000'] if video else
                    ['-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', str(min(rate, 128000))])
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                '-f', DEMUXERS[mime], '-i', str(source), *args, '-movflags', '+faststart', '-y', str(target)],
                capture_output=True, check=True, timeout=min(120, signal.remaining()) if signal else 120)
            if signal:
                signal.check()
            if target.stat().st_size > budget:
                raise unusable()
            return ('video/mp4' if video else 'audio/mp4'), target.read_bytes()
    except (subprocess.SubprocessError, OSError, ValueError, KeyError):
        raise unusable() from None


class MediaInputs:
    """Owns temporary GCS objects, using the ordinary storage identity for writes and deletion."""
    def __init__(self, storage=None):
        self.storage = storage
        self.temporary = []

    def adapter(self):
        from apps.media.storage import GCSAdapter, get_storage
        if self.storage is None:
            try:
                self.storage = get_storage()
            except Exception as error:
                raise staging_failed() from error
        primary = self.storage.primary
        if not isinstance(primary, GCSAdapter):
            return None
        # Copies live at the bucket root, outside any media prefix, so one lifecycle rule and IAM condition cover them.
        return GCSAdapter(primary.client, primary.bucket, timeout=primary.timeout)

    def part(self, mime, data, *, signal=None, inline_budget=INLINE_BYTES):
        """Every Cloud Storage handoff is a fresh ``ai-inputs/`` copy; Vertex never reads another object."""
        if signal:
            signal.check()
        adapter = self.adapter()
        if adapter is None:
            mime, data = shrink(mime, data, inline_budget, signal)
            return {'inlineData': {'mimeType': mime, 'data': base64.b64encode(data).decode()}}
        if len(data) > URI_BYTES:
            mime, data = shrink(mime, data, URI_BYTES, signal)
        key = f'{AI_INPUTS}{uuid4()}'
        # Register before writing: a timeout may have committed the upload.
        self.temporary.append((adapter, key))
        try:
            adapter.put(key, data, mime, 'private, no-store')
        except Exception as error:
            raise staging_failed() from error
        if signal:
            signal.check()
        return {'fileData': {'mimeType': mime, 'fileUri': f'gs://{adapter.bucket}/{key}'}}

    def release(self):
        temporary, self.temporary = self.temporary, []
        for adapter, key in temporary:
            try:
                adapter.delete(key)
            except Exception as error:
                logger.warning('vertex_media_cleanup_failed error_type=%s', type(error).__name__)


def vertex_uri_allowed(uri):
    """Only a task-scoped ``ai-inputs/`` copy in this deployment's media bucket, never an original or another bucket."""
    from apps.media.storage import GCSAdapter, get_storage
    adapter = get_storage().primary
    if not isinstance(adapter, GCSAdapter) or not isinstance(uri, str):
        return False
    root = f'gs://{adapter.bucket}/{AI_INPUTS}'
    return re.fullmatch(re.escape(root) + UUID, uri) is not None


@contextmanager
def prepared_request(url, body, signal=None):
    """All Vertex generateContent callers share this handoff, after their original-body authorization.

    Mutates neither the caller's payload nor persisted snapshots. Small and Gemini API bodies pass through intact.
    """
    if not vertex_endpoint(url) or not isinstance(body, dict):
        yield body
        return
    parts = [part for turn in body.get('contents', []) for part in turn.get('parts', []) if 'inlineData' in part]
    encoded = [part['inlineData']['data'] for part in parts]
    sizes = [len(data) * 3 // 4 - (2 if data.endswith('==') else 1 if data.endswith('=') else 0) for data in encoded]
    if not parts or (max(sizes) <= INLINE_BYTES and sum(sizes) <= INLINE_TOTAL):
        yield body
        return
    prepared = copy.deepcopy(body)
    inputs = MediaInputs()
    used = 0
    try:
        for turn in prepared.get('contents', []):
            for part in turn.get('parts', []):
                if 'inlineData' not in part:
                    continue
                inline = part['inlineData']
                data = base64.b64decode(inline['data'], validate=True)
                # Equal allocation guarantees a fallback batch also fits the aggregate request budget.
                budget = min(INLINE_BYTES, INLINE_TOTAL // len(parts)) if inputs.adapter() is None else INLINE_BYTES
                if len(data) > budget or used + len(data) > INLINE_TOTAL:
                    replacement = inputs.part(inline['mimeType'], data, signal=signal, inline_budget=budget)
                    del part['inlineData']
                    part.update(replacement)
                    if 'inlineData' in replacement:
                        used += len(base64.b64decode(replacement['inlineData']['data']))
                else:
                    used += len(data)
        yield prepared
    finally:
        inputs.release()
