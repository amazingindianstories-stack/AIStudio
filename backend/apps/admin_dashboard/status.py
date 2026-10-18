"""Live read-only dependency checks. Tests inject transports, never credentials."""
import json
import os
import re
import subprocess
import time
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from django.db import connection, connections
from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.model_registry import provider_model_id
from apps.media.storage import get_storage
from apps.media.keys import media_key_from_ref
from apps.canvas.views import reply, failure
from .admin_api import node_route, admin
from .queries import query


def outcome(status, detail): return {'status': status, 'detail': detail}


def http_status(url, headers=None, timeout=5):
    try:
        with urlopen(Request(url, headers=headers or {}), timeout=timeout) as response:
            # Close without downloading a provider/media response body.
            return response.status
    except HTTPError as error:
        status = error.code
        error.close()
        return status


def gemini(transport=http_status, model='Nano Banana Pro'):
    # Model metadata read (models.get); no generation is requested.
    key = os.environ.get('GOOGLE_API_KEY')
    if not key: return outcome('unknown', 'GOOGLE_API_KEY not set')
    status = transport('https://generativelanguage.googleapis.com/v1beta/models/' + provider_model_id(model, {}), {'x-goog-api-key': key})
    return outcome('ok' if 200 <= status < 300 else 'error', 'HTTP 200' if 200 <= status < 300 else f'HTTP {status}')


def higgsfield():
    # This check never exchanges a refresh token or calls a provider tool.
    try:
        token = json.loads(get_storage().read_private_buffer('settings/higgsfield-mcp-token.json'))
    except Exception:
        if os.environ.get('HIGGSFIELD_MCP_REFRESH_TOKEN') and os.environ.get('HIGGSFIELD_MCP_CLIENT_ID'):
            token = {}
        else:
            try:
                token = json.loads(Path('.higgsfield-mcp-token.json').read_text())
                token.setdefault('obtained_at', now_ms())
            except Exception:
                return outcome('unknown', 'No Higgsfield token found (storage backend/env/local file)')
    fresh = token.get('access_token') and token.get('obtained_at') and token.get('expires_in') and now_ms() < token['obtained_at'] + (token['expires_in'] - 300)*1000
    return outcome('ok', 'Cached access token fresh') if fresh else outcome('unknown', 'Token present but access token not fresh — refresh not triggered')


def configured(key):
    return outcome('ok', key + ' set (config-presence only)') if os.environ.get(key) else outcome('unknown', key + ' not set')


def omni():
    if os.environ.get('OMNI_USE_VERTEX') == '1':
        return outcome('ok', 'Vertex configured (config-presence only)') if os.environ.get('GOOGLE_CLOUD_PROJECT') else outcome('unknown', 'OMNI_USE_VERTEX=1 but GOOGLE_CLOUD_PROJECT not set')
    return outcome('ok', 'generativelanguage configured (config-presence only)') if os.environ.get('GOOGLE_API_KEY') else outcome('unknown', 'GOOGLE_API_KEY not set')


def postgres():
    query('SELECT 1 AS ready')
    return outcome('ok', 'select 1 ok')


def generation_indexes():
    names = [index.name for index in Generation._meta.indexes]
    actual = {row['name']: row['valid'] for row in query("SELECT i.relname AS name,x.indisvalid AS valid FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname='generations'")}
    missing = [name for name in names if name not in actual]
    invalid = [name for name in names if actual.get(name) is False]
    parts = (['missing: ' + ', '.join(missing)] if missing else []) + (['invalid: ' + ', '.join(invalid)] if invalid else [])
    return outcome('error', '; '.join(parts)) if parts else outcome('ok', f'{len(names)}/{len(names)} expected indexes valid')


def stuck_generations():
    now = now_ms()
    rows = query("""SELECT kind,count(*)::int AS count,min(updated_at)::bigint AS oldest FROM generations g WHERE status='running' AND
        ((kind='image' AND updated_at<%s) OR (kind='video' AND updated_at<%s) OR
        (kind='depth' AND updated_at<%s AND NOT EXISTS(SELECT 1 FROM depth_workers w WHERE w.current_job_id=g.id AND w.last_seen_at>=%s))) GROUP BY kind ORDER BY kind""",
        [now-600000, now-2700000, now-120000, now-45000])
    if not rows: return outcome('ok', 'No stuck running generations')
    summary = '; '.join(f"{row['kind']}: {row['count']} (oldest {max(0, (now-row['oldest'])//60000)}m)" for row in rows)
    return outcome('error', f"{sum(row['count'] for row in rows)} stuck — {summary}")


def storage():
    service = get_storage()
    reachable = service.check_connectivity()
    if reachable is False: return outcome('error', 'Media storage is not reachable')
    from apps.media.storage import GCSAdapter, S3Adapter
    label = f'GCS bucket {service.primary.bucket}' if isinstance(service.primary, GCSAdapter) else f'S3 bucket {service.primary.bucket}' if isinstance(service.primary, S3Adapter) else 'Media storage'
    return outcome('ok', label + ' reachable')


def ffmpeg():
    result = subprocess.run([os.environ.get('FFMPEG_PATH', 'ffmpeg'), '-version'], capture_output=True, text=True, timeout=3, check=True)
    line = result.stdout.split('\n', 1)[0]
    return outcome('ok', line[:160]) if re.match(r'ffmpeg version\s+', line, re.I) else outcome('error', 'ffmpeg executable returned an unexpected response')


def media_delivery(transport=http_status):
    key = None
    for row in Generation.objects.filter(status='succeeded').order_by('-updated_at').values('url', 'poster')[:20]:
        for value in (row['url'], row['poster']):
            if value:
                key = media_key_from_ref(value)
                if key: break
        if key: break
    if not key: return outcome('unknown', 'No recent stored media is available for a read probe')
    direct = get_storage().browser_url(key)
    if not direct: return outcome('error', 'Browser delivery fell back to proxying bytes through the function')
    status = transport(direct, {'Range': 'bytes=0-0'})
    return outcome('ok', f'Direct browser media read succeeded (HTTP {status}; object identity redacted)') if status in (200, 206) else outcome('error', f'Direct browser media read returned HTTP {status}')


CHECKS = [
    ('gemini', 'Gemini / Nano Banana Pro', gemini),
    ('gemini-nano-banana-2-1', 'Gemini / Nano Banana 2.1', lambda: gemini(model='Nano Banana 2.1')),
    ('higgsfield', 'Higgsfield MCP', higgsfield),
    ('seedance', 'BytePlus ModelArk / Seedance', lambda: configured('ARK_API_KEY')), ('kling', 'KlingAI Image', lambda: configured('KLING_API')),
    ('omni', 'Gemini Omni Flash 1.1', omni), ('postgres', 'Postgres', postgres), ('generation-indexes', 'Generation Indexes', generation_indexes),
    ('stuck-generations', 'Stuck Generations', stuck_generations), ('storage', 'Media Storage', storage),
    ('ffmpeg-runtime', 'ffmpeg Runtime', ffmpeg), ('media-delivery', 'Media Delivery', media_delivery),
]

# A response deadline cannot cancel a running network/storage call. Keep its
# capacity reserved until it finishes, across subsequent diagnostic requests.
_probe_capacity = threading.BoundedSemaphore(len(CHECKS))
_probe_executor = ThreadPoolExecutor(max_workers=len(CHECKS), thread_name_prefix='dependency-probe')


def run_all_checks(checks=None, timeout_ms=5000):
    checks = CHECKS if checks is None else checks
    checked = now_ms()
    def work(check):
        started = time.monotonic()
        try:
            try: value = check()
            except Exception as error:
                from .runtime_audit import sanitize
                value = outcome('error', sanitize(str(error)))
            return {**value, 'latencyMs': int((time.monotonic()-started)*1000), 'checkedAt': now_ms()}
        finally: connections.close_all()
    started = time.monotonic()
    futures = []
    for _, _, check in checks:
        if not _probe_capacity.acquire(blocking=False):
            futures.append(None)
            continue
        try:
            future = _probe_executor.submit(work, check)
        except Exception:
            _probe_capacity.release()
            raise
        future.add_done_callback(lambda completed: _probe_capacity.release())
        futures.append(future)
    results = []
    for (identifier, name, _), future in zip(checks, futures):
        if future is None:
            results.append({'id': identifier, 'name': name, **outcome('error', 'Diagnostic capacity busy'),
                            'latencyMs': 0, 'checkedAt': now_ms()})
            continue
        try: result = future.result(timeout=max(0, timeout_ms/1000-(time.monotonic()-started)))
        except TimeoutError:
            result = {**outcome('error', f'Timed out after {timeout_ms}ms'), 'latencyMs': int((time.monotonic()-started)*1000), 'checkedAt': now_ms()}
        except Exception:
            result = {**outcome('error', 'internal check error'), 'latencyMs': 0, 'checkedAt': now_ms()}
        results.append({**result, 'id': identifier, 'name': name})
    return {'checkedAt': checked, 'checks': results}


@node_route(['GET'])
def status_view(request):
    if admin(request) is None: return reply(request, {'error': 'FORBIDDEN'}, 403)
    try: return reply(request, run_all_checks())
    except Exception: return failure()
