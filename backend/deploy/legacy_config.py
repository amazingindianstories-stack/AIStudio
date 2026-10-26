"""Read the Green services' existing launcher configuration (transition shim).

The Green services keep their credentials in one JSON variable per service
(``GOAL4_PREVIEW_CONFIGURATION`` / ``GOAL4_PREVIEW_WORKER_CONFIGURATION``) that
the old env-injected launchers decoded. This module maps the same values onto
the named settings the versioned image uses, so the cutover changes only the
image and start command — never a variable — and rolling back is a redeploy.

Code blobs embedded in that configuration (overlays, gateway, paid guard) are
ignored: their behaviour now lives in reviewed source. Values are never logged.
"""
import base64
import hashlib
import json
import re
from urllib.parse import quote

API_VARIABLE = 'GOAL4_PREVIEW_CONFIGURATION'
WORKER_VARIABLE = 'GOAL4_PREVIEW_WORKER_CONFIGURATION'
DATABASE_HOST = 'green-postgres18.railway.internal:5432'
CA_SHA256 = 'b1f4b2fcbddfb295c2b12bd59c2d682c6f68c643efe6c1172677444ff3560465'
SYSTEM_IDENTIFIER = '7694884166196781094'
MIGRATION_ROWS = (60, 61, 62, 63, 64, 65, 66, 67)  # 67 includes generation.0006 (additive cancellation reconciliation)
API_ROLE = 'goal4_green_preview_api'
PROVIDER_KEYS = {'ARK_API_KEY', 'ARK_BASE_URL', 'GOOGLE_API_KEY', 'SEEDANCE_MODEL', 'SEEDANCE_MODEL_FAST'}
BYTEPLUS_KEYS = {'BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY', 'BYTEPLUS_ARK_REGION', 'BYTEPLUS_ARK_HOST', 'BYTEPLUS_ARK_BASE_URL'}
PASS_THROUGH = ('PATH', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID',
                'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_REPLICA_ID', 'DEPTH_WORKER_TOKEN', 'VEEVEE_PUBLIC_APP_URL_OVERRIDE',
                'VEEVEE_MAGNIFIC_UPSCALE', 'VEEVEE_GEMINI_OMNI', 'VEEVEE_KLING',
                'VEEVEE_GENERATION_WORKER_SLOTS')
# Magnific output hosts, observed in live tasks; signed, expiring links. Video
# results come from cdn-magnific.freepik.com (2026-10-14), image results from
# ai-statics.magnific.com (2026-10-15).
MAGNIFIC_MEDIA_HOSTS = ('cdn-magnific.freepik.com', 'ai-statics.magnific.com')
# Kling image result hosts, not yet observed in a live task. h1.inkwai.com is the result-URL example in Kling's
# image API reference (kling.ai/document-api/api/image/3-0-omni/image-generation, read 2026-10-19);
# cdn.klingai.com is the host in published sample responses of the same API. The first live canary must confirm.
KLING_MEDIA_HOSTS = ('h1.inkwai.com', 'cdn.klingai.com')
# KLING_API_HOST may only name a Kling API origin (the key is sent there); see apps.generation.providers.kling.
KLING_HOST = re.compile(r'https://(?:[a-z0-9-]+\.)+klingai\.com/?')


class LegacyConfigError(SystemExit):
    pass


def need(condition, message):
    if not condition:
        raise LegacyConfigError('legacy configuration: ' + message)


def present(env):
    return 'DATABASE_URL' not in env and (API_VARIABLE in env or WORKER_VARIABLE in env)


def _common(cfg, env, *, browser_origins, app_origin):
    need(cfg.get('database') == 'railway', 'unexpected database')
    ca = base64.b64decode(cfg['ca_base64'])
    need(hashlib.sha256(ca).hexdigest() == CA_SHA256, 'database CA does not match the pinned certificate')
    adc = cfg['adc']
    need(isinstance(adc, dict) and adc.get('client_email'), 'service account missing')
    out = {key: env[key] for key in PASS_THROUGH if env.get(key)}
    out.update({
        'DATABASE_URL': f"postgresql://{cfg['role']}:{quote(cfg['database_password'], safe='')}@{DATABASE_HOST}/{cfg['database']}",
        'VEEVEE_DATABASE_CA_PEM': ca.decode(),
        'GCP_ADC_JSON': json.dumps(adc),
        'GCP_SERVICE_ACCOUNT_EMAIL': adc['client_email'],
        'GCP_MEDIA_BUCKET': 'aistudio-media-bucket',
        'GCP_PROJECT_ID': 'ais-project-for-gcp',
        'VEEVEE_MEDIA_BACKEND': 'gcs',
        'VEEVEE_MEDIA_PREFIX': cfg['media_prefix'],
        'DJANGO_SECRET_KEY': cfg['django_secret'],
        'AUTH_SECRET': cfg['auth_secret'],
        'DJANGO_ALLOWED_HOSTS': '127.0.0.1',
        'DJANGO_BROWSER_ORIGINS': browser_origins,
        'PUBLIC_APP_URL': env.get('VEEVEE_PUBLIC_APP_URL_OVERRIDE') or app_origin,
        'LOCAL_DATA_MODE': 'fixtures',
        'MOCK_GENERATION': '1',
        'MOCK_ASSET_PROVIDER': '1',
        'AWS_EC2_METADATA_DISABLED': 'true',
        'PYTHONUNBUFFERED': '1',
        'LANG': 'C.UTF-8',
    })
    out.pop('VEEVEE_PUBLIC_APP_URL_OVERRIDE', None)
    # The Magnific key reaches Django only while upscaling is switched on.
    if env.get('VEEVEE_MAGNIFIC_UPSCALE') == '1' and env.get('MAGNIFIC_API_KEY'):
        out['MAGNIFIC_API_KEY'] = env['MAGNIFIC_API_KEY']
    paid = cfg.get('paid')
    if paid:
        provider = paid['provider_environment']
        need(set(provider) <= PROVIDER_KEYS and provider.get('ARK_API_KEY') and provider.get('GOOGLE_API_KEY'), 'provider environment')
        guard = {key: value for key, value in paid['configuration'].items() if key != 'authorization'}
        out.update(provider)
        out.update({'MOCK_GENERATION': '0', 'MOCK_ASSET_PROVIDER': '0', 'VEEVEE_PAID_GUARD': json.dumps(guard)})
    return out


def _kling(component, env, out):
    """``VEEVEE_KLING=1`` (a Railway service variable on the API and the generation worker) admits Kling images.
    Only the generation worker calls Kling (submit, poll, download), so only it receives the ``KLING_API`` service
    variable; an optional ``KLING_API_HOST`` must be a Kling host and reaches both, so their paid-guard quotes agree."""
    if env.get('VEEVEE_KLING') != '1' or component not in ('api', 'generation'):
        return out
    host = env.get('KLING_API_HOST')
    if host:
        need(KLING_HOST.fullmatch(host), 'KLING_API_HOST must be an https://<name>.klingai.com address')
        out['KLING_API_HOST'] = host
    if component == 'generation' and env.get('KLING_API'):
        out['KLING_API'] = env['KLING_API']
    return out


def _portrait_reads(env):
    reads = json.loads(env['GOAL4_PREVIEW_PORTRAIT_CONFIGURATION'])['read_environment']
    need(set(reads) <= BYTEPLUS_KEYS and reads.get('BYTEPLUS_ACCESS_KEY_ID') and reads.get('BYTEPLUS_SECRET_ACCESS_KEY'), 'portrait environment')
    return reads


def _managed_portraits(component, env, out):
    """``VEEVEE_MANAGED_PORTRAITS=1`` (a Railway service variable) turns on the automatic portrait pool. The API
    serves the Gallery, the generation worker registers assets and the scheduler expires them, so the two workers
    also need the BytePlus asset environment; without it they refuse to start rather than run half enabled."""
    if env.get('VEEVEE_MANAGED_PORTRAITS') != '1' or component not in ('api', 'generation', 'scheduler'):
        return out
    if component != 'api':
        need(env.get('GOAL4_PREVIEW_PORTRAIT_CONFIGURATION'), 'managed portraits need GOAL4_PREVIEW_PORTRAIT_CONFIGURATION on this worker')
        out.update(_portrait_reads(env))
    need(out.get('BYTEPLUS_ACCESS_KEY_ID'), 'managed portraits need the BytePlus portrait environment')
    out['VEEVEE_MANAGED_PORTRAITS'] = '1'
    return out


def translate(component, env):
    """Return the complete, allowlisted environment for ``component``."""
    if component == 'api':
        cfg = json.loads(env[API_VARIABLE])
        need(cfg.get('role') == API_ROLE, 'unexpected API role')
        out = _common(cfg, env, browser_origins=env.get('GOAL4_PREVIEW_BROWSER_ORIGINS', ''),
                      app_origin=env.get('GOAL4_PREVIEW_APP_ORIGIN', ''))
        out['VEEVEE_INGRESS_SECRET'] = cfg['ingress_secret']
        # The old launcher always served the gateway on 18081 (Railway's health check and domain target it).
        out['PORT'] = '18081'
        if cfg.get('new_exports'):
            out['VEEVEE_EXPORT_ADMISSION'] = '1'
        portraits = json.loads(env['GOAL4_PREVIEW_PORTRAIT_CONFIGURATION']) if env.get('GOAL4_PREVIEW_PORTRAIT_CONFIGURATION') else None
        if portraits:
            out.update(_portrait_reads(env))
            out['VEEVEE_PORTRAIT_LIFECYCLE'] = '1'
        return _kling(component, env, _managed_portraits(component, env, out))
    cfg = json.loads(env[WORKER_VARIABLE])
    need(cfg.get('kind') == component, 'configuration belongs to another worker')
    need(str(cfg.get('role', '')).startswith('goal4_') and cfg['role'].endswith('_worker'), 'unexpected worker role')
    need(cfg.get('historical_replay_authorized') is False, 'historical replay must stay disabled')
    need(cfg.get('paid_providers_authorized') is bool(cfg.get('paid')), 'paid authorization mismatch')
    need(not cfg.get('paid') or component in ('generation', 'scheduler'), 'paid providers on a non-generation worker')
    out = _common(cfg, env, browser_origins=cfg.get('browser_origins', cfg['browser_origin']),
                  app_origin=cfg.get('app_origin', cfg['browser_origin']))
    need(cfg['lease_prefix'].startswith('lease:g4preview:') and cfg['naming_prefix'].startswith('g4preview:'), 'namespace prefixes')
    out['VEEVEE_LEASE_PREFIX'] = cfg['lease_prefix']
    out['VEEVEE_NAMING_PREFIX'] = cfg['naming_prefix']
    hosts = cfg.get('provider_media_hosts', [])
    need(isinstance(hosts, list) and len(hosts) <= 8, 'provider media hosts')
    if env.get('VEEVEE_MAGNIFIC_UPSCALE') == '1':
        hosts = [*hosts, *(host for host in MAGNIFIC_MEDIA_HOSTS if host not in hosts)]
    if env.get('VEEVEE_KLING') == '1' and component == 'generation':
        hosts = [*hosts, *(host for host in KLING_MEDIA_HOSTS if host not in hosts)]
    out['VEEVEE_PROVIDER_MEDIA_HOSTS'] = ','.join(hosts)
    if cfg.get('new_exports'):
        out['VEEVEE_EXPORT_ADMISSION'] = '1'
    return _kling(component, env, _managed_portraits(component, env, out))


def preflight_contract(component, env):
    """Database facts every service must observe before it starts (from the old launchers)."""
    if component == 'api':
        return {'role': API_ROLE}
    cfg = json.loads(env[WORKER_VARIABLE])
    return {'role': cfg['role'], 'rls_tables': cfg['rls_tables'], 'hidden_job_contracts': cfg['hidden_job_contracts']}


def preflight(database_url, contract, connect=None):
    """Fail closed unless the connection is the expected database, role and job visibility."""
    if connect is None:
        import psycopg
        connect = psycopg.connect
    from psycopg import sql
    with connect(database_url) as db:
        identity = db.execute('SELECT current_database(), current_user, system_identifier::text FROM pg_control_system()').fetchone()
        need(tuple(identity) == ('railway', contract['role'], SYSTEM_IDENTIFIER), 'database identity')
        need(db.execute('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()').fetchone()[0], 'database connection is not TLS')
        need(db.execute('SELECT count(*) FROM public.django_migrations').fetchone()[0] in MIGRATION_ROWS, 'migration history')
        if 'rls_tables' not in contract:
            return
        flags = db.execute('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit FROM pg_roles WHERE rolname = current_user').fetchone()
        need(not any(flags), 'worker role has elevated privileges')
        for table in contract['rls_tables']:
            need(db.execute('SELECT relrowsecurity FROM pg_class WHERE oid = %s::regclass', ('public.' + table,)).fetchone()[0], 'row security disabled')
        for table, columns in contract['hidden_job_contracts'].items():
            held = sql.SQL('goal4_preview_worker_holds.{}(jsonb_build_array({}))').format(
                sql.Identifier('held_' + table), sql.SQL(',').join(sql.SQL('{}::text').format(sql.Identifier(c)) for c in columns))
            if table == 'generations':
                held = sql.SQL("({}) AND status IN ('queued','running')").format(held)
            if table == 'media_export_items':
                held = sql.SQL('({}) OR goal4_preview_worker_holds.held_media_exports(jsonb_build_array(export_id::text))').format(held)
            need(db.execute(sql.SQL('SELECT count(*) FROM public.{} WHERE {}').format(sql.Identifier(table), held)).fetchone()[0] == 0,
                 'historical jobs are visible to the worker')
