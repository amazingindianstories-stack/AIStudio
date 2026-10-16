"""Measure reference-audio length before a provider sees it.

Seedance rejects reference audio outside its per-clip and per-request duration
limits with a 400 after the job is queued. Measuring at enqueue lets the artist
fix the clip instead of retrying a job that cannot succeed.
"""
import logging
import math
import shutil
import subprocess
import tempfile

logger = logging.getLogger(__name__)

# ffprobe reads a <= 15 MB local file in milliseconds; keep the worst case far below the request timeout.
PROBE_TIMEOUT_SECONDS = 5


def audio_seconds(data):
    """Duration of the encoded audio in seconds, or None when it cannot be measured.

    None means "unknown", never "too long": callers must let the provider decide.
    """
    ffprobe = shutil.which('ffprobe')
    if not ffprobe or not data:
        if not ffprobe:
            logger.warning('reference_audio_probe_unavailable reason=ffprobe_missing')
        return None
    # A file, not a pipe: MP4/M4A may keep the index after the samples.
    with tempfile.NamedTemporaryFile(suffix='.audio') as handle:
        handle.write(data)
        handle.flush()
        try:
            result = subprocess.run(
                [ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', handle.name],
                capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            logger.warning('reference_audio_probe_failed reason=%s', type(error).__name__)
            return None
    try:
        seconds = float(result.stdout.strip())
    except ValueError:
        return None
    return seconds if math.isfinite(seconds) and seconds > 0 else None
