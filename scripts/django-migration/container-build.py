from frozen_oracle import run as oracle_run, check_output as oracle_output, schema_sql
"""Build/inspect the API image only from the isolation runner's clean copy."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import sys
import hashlib
import re

if '--orm-generations' in sys.argv and not {'--runtime', '--declared-schema'}.issubset(sys.argv):
    raise SystemExit('Generation ORM qualification requires runtime and declared schema')

if '--baseline' in sys.argv and not {'--runtime', '--declared-schema', '--invariants'}.issubset(sys.argv):
    raise SystemExit('Baseline qualification requires runtime, declared schema and invariants')
if '--tests' in sys.argv and '--runtime' not in sys.argv:
    raise SystemExit('Full test qualification requires the disposable runtime network')
if '--roles' in sys.argv and '--baseline' not in sys.argv:
    raise SystemExit('Role qualification requires the verified PG16 baseline runtime')

root = Path.cwd()
home = Path(os.environ['HOME'])
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or root.parent.name != home.parent.name or root.name != 'repo' or root.parent.parent != Path('/private/tmp'):
    raise SystemExit('Container qualification requires the verified isolated source copy')
socket = 'unix:///Users/ais4/.docker/run/docker.sock'
plugins = '/Applications/Docker.app/Contents/Resources/cli-plugins'
image = 'veevee-django-qualification:local'
revision = os.environ['VEEVEE_SOURCE_REVISION']
if not re.fullmatch(r'[0-9a-f]{40}', revision):
    raise SystemExit('Explicit source revision required')
# Fingerprint actual API inputs, including local changes, rather than implying
# a revision label attests to an unchanged checkout.
digest = hashlib.sha256()
for source in sorted(Path('backend').rglob('*')):
    if not source.is_file() or source.is_symlink() or any(part in {'__pycache__','.venv','venv'} for part in source.parts):
        continue
    if source.suffix != '.py' and not (source.suffix == '.json' and 'testsupport/goldens' in source.as_posix()) and source.name not in {'requirements.txt','constraints-qualified.txt','Dockerfile','Dockerfile.dockerignore'}:
        continue
    digest.update(source.as_posix().encode() + b'\0' + hashlib.sha256(source.read_bytes()).digest())
fingerprint = digest.hexdigest()
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='docker-config-') as config:
    # No personal registry credentials; explicitly discover bundled BuildKit.
    Path(config, 'config.json').write_text(json.dumps({'cliPluginsExtraDirs': [plugins]}))
    docker = ['docker', '--config', config, '--host', socket]
    env = dict(os.environ, DOCKER_BUILDKIT='1')
    subprocess.run(docker + ['buildx', 'build', '--load', '--file', 'backend/Dockerfile', '--tag', image,
                            '--label',f'org.opencontainers.image.revision={revision}',
                            '--label',f'io.veevee.api-source-sha256={fingerprint}', '.'], env=env, check=True)
    metadata = json.loads(subprocess.check_output(docker + ['image','inspect',image], env=env, text=True))[0]
    assert metadata['Config']['Labels']['org.opencontainers.image.revision'] == revision
    assert metadata['Config']['Labels']['io.veevee.api-source-sha256'] == fingerprint
    print(json.dumps({'source_revision':revision,'api_source_sha256':fingerprint,'image_id':metadata['Id']}))
    inspection = '''import json, pathlib, django, rest_framework, gunicorn
files=[p.relative_to('/app').as_posix() for p in pathlib.Path('/app').rglob('*') if p.is_file()]
allowed={'requirements.txt','constraints-qualified.txt','Dockerfile','Dockerfile.dockerignore'}
unexpected=[p for p in files if not p.endswith('.py') and not (p.startswith('testsupport/goldens/') and p.endswith('.json')) and p not in allowed]
assert not unexpected, unexpected
assert 'manage.py' in files and 'config/wsgi.py' in files
print(json.dumps({'application_file_count':len(files),'unexpected_files':unexpected,'django':django.get_version(),'drf':rest_framework.VERSION,'gunicorn':gunicorn.__version__}))'''
    subprocess.run(docker + ['run', '--rm', '--network', 'none', '--entrypoint', 'python', image, '-c', inspection], env=env, check=True)
    if '--runtime' in sys.argv:
        suffix = uuid.uuid4().hex[:12]
        network, database, api = [f'veevee-qualification-{kind}-{suffix}' for kind in ('net','pg','api')]
        def run(args, **kwargs):
            result = subprocess.run(docker + args, env=env, capture_output=True, text=True, **kwargs)
            if result.returncode:
                # All targets/credentials here are explicitly synthetic containers.
                raise RuntimeError(result.stderr.strip() or 'Disposable Docker command failed')
            return result.stdout.strip()
        def wait_for(callback, seconds=45):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                try:
                    return callback()
                except (RuntimeError, AssertionError):
                    time.sleep(.5)
            raise RuntimeError('Disposable container readiness deadline exceeded')
        health_probe = '''import json, urllib.request, urllib.error
try:
 r=urllib.request.urlopen('http://127.0.0.1:8000/api/health?private=DO_NOT_LOG',timeout=10)
except urllib.error.HTTPError as e:
 r=e
print(json.dumps({'status':r.status,'body':json.loads(r.read()),'cache':r.headers.get('Cache-Control'),'request_id':r.headers.get('X-Request-ID')}))'''
        def health(expected):
            result = json.loads(run(['exec', api, 'python', '-c', health_probe]))
            assert result['status'] == expected, result
            assert result['cache'] == 'no-store' and result['request_id'], result
            assert result['body'] == {'ok':expected == 200,'django':'ready','database':'ready' if expected == 200 else 'unavailable'}, result
            return result
        created = []
        try:
            run(['network','create','--internal',network])
            run(['run','--detach','--name',database,'--network',network,
                 '--tmpfs','/var/lib/postgresql/data','--env','POSTGRES_USER=migration',
                 '--env','POSTGRES_PASSWORD=disposable-only','--env','POSTGRES_DB=veevee_django_migration','postgres:16'])
            created.append(database)
            # Inspect actual network/image/mount targets before database utilities.
            target = json.loads(run(['inspect',database]))[0]
            assert target['Config']['Image'] == 'postgres:16'
            assert set(target['NetworkSettings']['Networks']) == {network}
            assert all(m['Type'] == 'tmpfs' for m in target['Mounts'])
            wait_for(lambda: run(['exec',database,'pg_isready','-U','migration','-d','veevee_django_migration']))
            version = run(['exec',database,'psql','-U','migration','-d','veevee_django_migration','-Atc','SHOW server_version'])
            assert version.startswith('16.'), version
            run(['run','--detach','--name',api,'--network',network,
                 '--env',f'DATABASE_URL=postgresql://migration:disposable-only@{database}:5432/veevee_django_migration',
                 '--env','DJANGO_SECRET_KEY=disposable-framework-secret',
                 '--env','AUTH_SECRET=disposable-session-secret',
                 '--env','DJANGO_ALLOWED_HOSTS=127.0.0.1',
                 '--env','DJANGO_BROWSER_ORIGINS=https://frontend.example',image])
            created.append(api)
            ready = wait_for(lambda: health(200))
            for _ in range(12):
                health(200)  # Exercise both Gunicorn workers before the outage.
            run(['stop','--time','1',database])
            failed = wait_for(lambda: health(503))
            run(['start',database])
            wait_for(lambda: run(['exec',database,'pg_isready','-U','migration','-d','veevee_django_migration']))
            recovered = wait_for(lambda: health(200))
            def sql(statement):
                return run(['exec','--interactive',database,'psql','-U','migration','-d','veevee_django_migration','-v','ON_ERROR_STOP=1','-At'], input=statement)
            if '--declared-schema' in sys.argv:
                sql(schema_sql())
                table_count = int(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"))
                assert table_count == 21, table_count
                if '--invariants' in sys.argv:
                    exported = oracle_run(['node','--import','tsx','scripts/django-migration/invariant-statements.mjs'],
                                              env=env,check=True,capture_output=True,text=True)
                    statements = json.loads(exported.stdout)
                    for _ in range(2):
                        for domain in ('hierarchy','naming'):
                            sql('BEGIN;\n' + ';\n'.join(statements[domain]) + ';\nCOMMIT;')
                    invariant_counts = json.loads(sql("SELECT jsonb_build_object('functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'triggers',(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal));"))
                    assert invariant_counts['functions'] > 0 and invariant_counts['triggers'] > 0, invariant_counts
                    sql(Path('scripts/django-migration/invariant-behavior.sql').read_text())
                if '--baseline' in sys.argv:
                    # Source check is read from the current additive migration.
                    checks = json.loads(oracle_output(['node','scripts/django-migration/declared-checks.mjs'], env=env, text=True))
                    color = next(check for check in checks if check['name'] == 'folders_color_check')
                    sql(f"ALTER TABLE folders ADD CONSTRAINT folders_color_check CHECK ({color['sql']});")
                    import importlib.util
                    spec = importlib.util.spec_from_file_location('schema_catalog', 'scripts/django-migration/schema-catalog.py')
                    catalog = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(catalog)
                    probe = Path('scripts/django-migration/baseline-container-probe.py').read_text()
                    payload = json.dumps({'queries': catalog.QUERIES})
                    current = json.loads(run(['exec','--interactive','-e','VEEVEE_BASELINE_TEST=1',api,'python','-c',probe], input=payload))
                    run(['exec',database,'createdb','-U','migration','veevee_django_baseline'])
                    baseline_url = f'DATABASE_URL=postgresql://migration:disposable-only@{database}:5432/veevee_django_baseline'
                    candidate = json.loads(run(['exec','--interactive','-e','VEEVEE_BASELINE_TEST=1','-e',baseline_url,api,'python','-c',probe], input=payload))
                    differences = catalog.compare(current['catalog'], candidate['catalog'])
                    evidence = {'equivalent': not differences, 'different_categories': differences,
                                'postgres_version': version, 'committed_migrations': candidate['committed_migrations'],
                                'fresh_database': True, 'connection_reopened': True,
                                'category_counts': {key: len(rows) for key, rows in candidate['catalog'].items()},
                                'source_revision': revision, 'api_source_sha256': fingerprint}
                    assert not differences, json.dumps({'different_categories': differences})
                    behavior = Path('scripts/django-migration/invariant-behavior.sql').read_text()
                    run(['exec','--interactive',database,'psql','-U','migration','-d','veevee_django_baseline','-v','ON_ERROR_STOP=1','-At'], input=behavior)
                    evidence['invariant_behavior_both_databases'] = True
                    adoption_probe = Path('scripts/django-migration/baseline-adoption-probe.py').read_text()
                    adoption_payload = json.dumps({'queries': catalog.QUERIES, 'expected_catalog': candidate['catalog'], 'legacy_history': json.loads(Path('docs/django-migration/transitional-migration-history.json').read_text())['migrations'], 'populated_fixture_source': Path('scripts/django-migration/populated-adoption-fixture.py').read_text()})
                    adoption = json.loads(run(['exec','--interactive','-e','VEEVEE_BASELINE_TEST=1',api,'python','-c',adoption_probe], input=adoption_payload))
                    evidence['populated_database_adoption'] = adoption
                    upgrade_probe = Path('scripts/django-migration/additive-upgrade-probe.py').read_text()
                    for target_env in (None, baseline_url):
                        arguments = ['exec','--interactive','-e','VEEVEE_BASELINE_TEST=1']
                        if target_env: arguments += ['-e',target_env]
                        arguments += [api,'python','-c',upgrade_probe]
                        upgraded = json.loads(run(arguments,input=payload))
                        assert upgraded['application_rows_preserved'] and upgraded['exact_additive_catalog_verified']
                    evidence['additive_upgrade'] = upgraded
                    orm_probe = Path('scripts/django-migration/generation-persistence-probe.py').read_text()
                    print(run(['exec','-e','VEEVEE_GENERATION_PERSISTENCE_TEST=1','-e','VEEVEE_BASELINE_TEST=1','-e',baseline_url,api,'python','-c',orm_probe]))
                    evidence['generation_orm_qualified_on_django_baseline'] = True

                    Path('/private/tmp/veevee-pg16-baseline-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
                    print(json.dumps(evidence))
                sql("INSERT INTO users (id,email,password_hash,password_salt,name,role,is_active,auth_version,created_at) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture@example.invalid','synthetic-unused','synthetic-unused','Fixture','user',true,0,0);")
            else:
                sql('''CREATE TABLE users (id uuid PRIMARY KEY,email text,name text,role text,color text,avatar_url text,is_active boolean,auth_version integer);
CREATE TABLE settings (key text PRIMARY KEY,value text NOT NULL,updated_at bigint NOT NULL);
CREATE TABLE user_limits (user_id uuid,key text,value text NOT NULL,updated_at bigint NOT NULL,PRIMARY KEY(user_id,key));
INSERT INTO users VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture@example.invalid','Fixture','user',NULL,NULL,true,0);''')
            settings_probe = '''import base64, hashlib, hmac, json, time, urllib.request, urllib.error
from http.cookies import SimpleCookie
encode=lambda b:base64.urlsafe_b64encode(b).decode().rstrip('=')
payload=encode(json.dumps({'uid':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ver':0,'exp':int(time.time()*1000)+28*86400000}).encode())
token=payload+'.'+encode(hmac.new(b'disposable-session-secret',payload.encode(),hashlib.sha256).digest())
headers={'Cookie':'veevee_session='+token}
request=urllib.request.Request('http://127.0.0.1:8000/api/settings',headers=headers)
try:
 r=urllib.request.urlopen(request,timeout=10)
except urllib.error.HTTPError as e:
 r=e
cookie=SimpleCookie(r.headers.get('Set-Cookie',''))
renewal=cookie.get('veevee_session')
flags=bool(renewal and renewal['secure'] and renewal['httponly'] and renewal['samesite']=='Lax' and renewal['path']=='/' and renewal['max-age']=='2592000')
accepted=False
if renewal:
 follow=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8000/api/settings',headers={'Cookie':'veevee_session='+renewal.value}),timeout=10)
 accepted=follow.status==200 and not follow.headers.get('Set-Cookie')
print(json.dumps({'status':r.status,'body':json.loads(r.read()),'secure_renewal':flags,'renewal_accepted':accepted}))'''
            snapshot_sql = "SELECT jsonb_build_object('users',(SELECT jsonb_agg(to_jsonb(u)) FROM users u),'settings',(SELECT jsonb_agg(to_jsonb(s) ORDER BY key) FROM settings s),'limits',(SELECT jsonb_agg(to_jsonb(l) ORDER BY user_id,key) FROM user_limits l));"
            cases = [
                ('defaults','',200,{'maxPromptLength':30000,'maxConcurrentJobs':4}),
                ('overrides',"INSERT INTO settings VALUES ('maxPromptLength','12000',0),('maxConcurrentJobs','3',0); INSERT INTO user_limits VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','maxConcurrentJobs','2',0);",200,{'maxPromptLength':12000,'maxConcurrentJobs':2}),
                ('invalid-personal',"INSERT INTO user_limits VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','maxPromptLength','invalid',0); UPDATE user_limits SET value='9tail' WHERE key='maxConcurrentJobs';",200,{'maxPromptLength':30000,'maxConcurrentJobs':4}),
                ('version-mismatch','UPDATE users SET auth_version=1;',401,{'error':'UNAUTHENTICATED'}),
                ('disabled','UPDATE users SET auth_version=0,is_active=false;',401,{'error':'UNAUTHENTICATED'}),
            ]
            if '--connection-recovery' in sys.argv:
                for _ in range(12):
                    health(200)
                sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='veevee_django_migration' AND pid<>pg_backend_pid();")
            for name, mutation, status, body in cases:
                if mutation:
                    sql(mutation)
                before = sql(snapshot_sql)
                try:
                    result = json.loads(run(['exec',api,'python','-c',settings_probe]))
                except RuntimeError:
                    diagnostic = subprocess.run(docker + ['logs','--tail','60',api],env=env,capture_output=True,text=True)
                    print(diagnostic.stderr, file=sys.stderr)
                    raise
                assert result['status'] == status and result['body'] == body, name
                assert result['secure_renewal'] == (status == 200), name
                assert result['renewal_accepted'] == (status == 200), name
                assert sql(snapshot_sql) == before, name
            if '--orm-generations' in sys.argv:
                probe = Path('scripts/django-migration/generation-persistence-probe.py').read_text()
                print(run(['exec','-e','VEEVEE_GENERATION_PERSISTENCE_TEST=1',api,'python','-c',probe]))
            if '--roles' in sys.argv:
                worker_image = 'veevee-django-worker-qualification:local'
                worker_digest = hashlib.sha256(fingerprint.encode())
                for filename in ('Dockerfile.worker', 'Dockerfile.worker.dockerignore'):
                    worker_digest.update(filename.encode() + b'\0' + hashlib.sha256(Path(filename).read_bytes()).digest())
                worker_fingerprint = worker_digest.hexdigest()
                subprocess.run(docker + ['buildx', 'build', '--load', '--file', 'Dockerfile.worker', '--tag', worker_image,
                    '--label', f'org.opencontainers.image.revision={revision}',
                    '--label', f'io.veevee.worker-source-sha256={worker_fingerprint}', '.'], env=env, check=True)
                worker_metadata = json.loads(run(['image', 'inspect', worker_image]))[0]
                assert worker_metadata['Config']['Labels']['io.veevee.worker-source-sha256'] == worker_fingerprint
                assert worker_metadata['Config']['Labels']['org.opencontainers.image.revision'] == revision
                assert worker_metadata['Config']['Cmd'] == ['python', 'manage.py', 'generation_worker']
                subprocess.run(docker + ['run', '--rm', '--network', 'none', '--entrypoint', 'python', worker_image, '-c', inspection], env=env, check=True)
                # Schema/history snapshots prove role startup does not migrate.
                # Maintenance may legitimately modify disposable application rows.
                def schema_snapshot():
                    def baseline_sql(query):
                        return run(['exec', '--interactive', database, 'psql', '-U', 'migration',
                                    '-d', 'veevee_django_baseline', '-v', 'ON_ERROR_STOP=1', '-At'], input=query)
                    return {category: baseline_sql(query) for category, query in catalog.QUERIES.items()} | {
                        'migration_history': baseline_sql('SELECT app,name FROM django_migrations ORDER BY app,name')}
                before_roles = schema_snapshot()
                role_results = []
                for role, command, role_image in (
                    ('generation', 'generation_worker', worker_image),
                    ('export', 'media_export_worker', image),
                    ('scheduler', 'run_scheduler', image),
                ):
                    name = f'veevee-qualification-{role}-{suffix}'
                    values = {
                        'DATABASE_URL': f'postgresql://migration:disposable-only@{database}:5432/veevee_django_baseline',
                        'DJANGO_SECRET_KEY': 'disposable-framework-secret', 'AUTH_SECRET': 'disposable-session-secret',
                        'DJANGO_ALLOWED_HOSTS': '127.0.0.1', 'DJANGO_BROWSER_ORIGINS': 'https://frontend.example',
                        'MOCK_GENERATION': '1', 'MOCK_ASSET_PROVIDER': '1', 'AWS_EC2_METADATA_DISABLED': 'true',
                        'VEEVEE_MEDIA_BACKEND': 'filesystem', 'VEEVEE_MEDIA_ROOT': '/tmp/disposable-media',
                    }
                    arguments = ['--network', network]
                    for key, value in values.items():
                        arguments += ['--env', key + '=' + value]
                    # A successful tick proves database/schema/config readiness;
                    # a running PID alone would allow an endless exception loop.
                    tick_output = run(['run', '--rm', *arguments, '--entrypoint', 'python', role_image,
                                       'manage.py', command, '--once'])
                    tick_result = json.loads(tick_output.splitlines()[-1])
                    def failed_tick(value):
                        if isinstance(value, dict):
                            return value.get('ok') is False or bool(value.get('errors')) or bool(value.get('worker_error')) or any(failed_tick(item) for item in value.values())
                        return isinstance(value, list) and any(failed_tick(item) for item in value)
                    assert not failed_tick(tick_result), f'{role} tick reported failure'
                    run(['run', '--detach', '--name', name, *arguments, role_image, 'python', 'manage.py', command])
                    created.append(name)
                    time.sleep(1)
                    state = json.loads(run(['inspect', name]))[0]
                    assert state['State']['Running'] and state['Config']['Cmd'] == ['python', 'manage.py', command]
                    assert set(state['NetworkSettings']['Networks']) == {network} and not state['Mounts']
                    run(['restart', '--time', '10', name])
                    time.sleep(1)
                    restarted = json.loads(run(['inspect', name]))[0]
                    assert restarted['State']['Running']
                    assert restarted['State']['StartedAt'] != state['State']['StartedAt']
                    run(['stop', '--time', '10', name])
                    assert json.loads(run(['inspect', name]))[0]['State']['ExitCode'] == 0
                    role_log_result = subprocess.run(docker + ['logs', name], env=env, check=True,
                                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                    role_logs = role_log_result.stdout
                    assert not any(marker in role_logs for marker in ('Traceback', 'worker_error', 'worker operation failed', 'Maintenance task failed')), f'{role} runtime logged failure'
                    role_results.append({'role': role, 'command': ['python', 'manage.py', command],
                                         'successful_tick': tick_result, 'started': True, 'restarted': True, 'graceful_stop': True})
                # Role clients use the baseline database, so compare that target.
                assert schema_snapshot() == before_roles, 'Role startup changed database schema/history'
                print(json.dumps({'distinct_worker_roles': role_results, 'worker_image_id': worker_metadata['Id'],
                                  'worker_source_sha256': worker_fingerprint, 'source_revision': revision,
                                  'mock_providers': True, 'storage': 'container-local filesystem',
                                  'startup_schema_history_unchanged': True}))
            logs = run(['logs',api])
            events = [json.loads(line) for line in logs.splitlines() if line.startswith('{')]
            assert any(e.get('status') == 200 for e in events)
            assert any(e.get('status') == 503 for e in events)
            assert 'DO_NOT_LOG' not in logs and 'disposable-only' not in logs
            print(json.dumps({'postgres_version':version,'container_health_ready':ready['status'],
                              'container_health_database_failure':failed['status'],
                              'container_health_recovered':recovered['status'],'sanitized_structured_logs':True,
                              'settings_contract_cases':[case[0] for case in cases],
                              'settings_database_unchanged':True,'secure_renewal_followup':True}))
            if '--declared-schema' in sys.argv:
                print(json.dumps({'declared_schema_tables':table_count,'schema_source':'frozen historical source-schema.json',
                                  'advanced_migration_invariants_qualified':False,'upgrade_coverage':False}))
                if '--invariants' in sys.argv:
                    print(json.dumps({'hierarchy_statements':len(statements['hierarchy']),
                                      'naming_statements':len(statements['naming']),
                                      'repeated_apply_passed':True,'catalog_counts':invariant_counts,
                                      'hierarchy_naming_behavior_cases':11,
                                      'complete_behavioral_invariants_qualified':False}))
            if '--tests' in sys.argv:
                # Exercise production Python/libvips/FFmpeg against PG16. Only the
                # password interoperability test needs Node's standard crypto;
                # copy its binary into an ephemeral test container, not the API
                # image. No Node application implementation or dependencies exist.
                crypto = f'veevee-qualification-crypto-{suffix}'
                runner = f'veevee-qualification-tests-{suffix}'
                run(['create','--name',crypto,'node:22-bookworm-slim','node','--version'])
                created.append(crypto)
                binary = Path(config) / 'node'
                run(['cp',f'{crypto}:/usr/local/bin/node',str(binary)])
                run(['run','--detach','--name',runner,'--network',f'container:{database}',
                     '--env','DATABASE_URL=postgresql://migration:disposable-only@127.0.0.1:5432/veevee_django_migration',
                     '--env','DJANGO_SECRET_KEY=disposable-framework-secret',
                     '--env','AUTH_SECRET=disposable-session-secret',
                     '--env','DJANGO_SETTINGS_MODULE=config.settings.test',
                     '--env','MIGRATION_TEST_ISOLATED=1',
                     '--env','MOCK_GENERATION=1','--env','MOCK_ASSET_PROVIDER=1',
                     '--env','AWS_EC2_METADATA_DISABLED=true',
                     '--entrypoint','sleep',image,'infinity'])
                created.append(runner)
                actual = json.loads(run(['inspect',runner]))[0]
                assert actual['HostConfig']['NetworkMode'] == f'container:{database}' or actual['HostConfig']['NetworkMode'] == 'container:'+target['Id']
                assert not actual['Mounts'] and not actual['HostConfig']['Privileged']
                assert run(['exec',database,'psql','-U','migration','-d','veevee_django_migration','-Atc','SHOW server_version']).startswith('16.')
                run(['cp',str(binary),f'{runner}:/usr/local/bin/node'])
                run(['exec',runner,'mkdir','-p','/scripts/django-migration'])
                for filename in ('password-oracle.mjs','schema-catalog.py'):
                    run(['cp',f'scripts/django-migration/{filename}',f'{runner}:/scripts/django-migration/{filename}'])
                labels = ['apps.common','apps.admin_dashboard','apps.library','apps.assets',
                          'apps.authentication','apps.projects','apps.canvas','apps.agents',
                          'apps.generation','apps.exports','apps.workers','apps.media','testsupport']
                result = subprocess.run(docker + ['exec',runner,'python','manage.py','test',*labels,'--noinput'],
                                        env=env,capture_output=True,text=True)
                print(result.stdout)
                print(result.stderr, file=sys.stderr)
                result.check_returncode()
                print(json.dumps({'full_django_suite_pg16':True,'network':'internal database namespace; no ports',
                                  'node_usage':'standard crypto interoperability only','native_libvips_ffmpeg':True}))
        finally:
            for name in reversed(created):
                subprocess.run(docker + ['rm','--force',name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(docker + ['network','rm',network], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
