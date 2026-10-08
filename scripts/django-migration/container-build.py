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
    if source.suffix != '.py' and source.name not in {'requirements.txt','Dockerfile','Dockerfile.dockerignore'}:
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
allowed={'requirements.txt','Dockerfile','Dockerfile.dockerignore'}
unexpected=[p for p in files if not p.endswith('.py') and p not in allowed]
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
        probe = '''import json, urllib.request, urllib.error
try:
 r=urllib.request.urlopen('http://127.0.0.1:8000/api/health?private=DO_NOT_LOG',timeout=10)
except urllib.error.HTTPError as e:
 r=e
print(json.dumps({'status':r.status,'body':json.loads(r.read()),'cache':r.headers.get('Cache-Control'),'request_id':r.headers.get('X-Request-ID')}))'''
        def health(expected):
            result = json.loads(run(['exec', api, 'python', '-c', probe]))
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
                with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='drizzle-schema-') as output:
                    subprocess.run(['node','node_modules/drizzle-kit/bin.cjs','generate',
                                    '--dialect=postgresql','--schema=./src/lib/schema.js',f'--out={output}'],
                                   env=env, check=True)
                    migrations = sorted(Path(output).glob('*.sql'))
                    assert len(migrations) == 1, 'Expected a fresh declared-schema migration'
                    sql(migrations[0].read_text())
                table_count = int(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';"))
                assert table_count == 21, table_count
                if '--invariants' in sys.argv:
                    exported = subprocess.run(['node','--import','tsx','scripts/django-migration/invariant-statements.mjs'],
                                              env=env,check=True,capture_output=True,text=True)
                    statements = json.loads(exported.stdout)
                    for _ in range(2):
                        for domain in ('hierarchy','naming'):
                            sql('BEGIN;\n' + ';\n'.join(statements[domain]) + ';\nCOMMIT;')
                    invariant_counts = json.loads(sql("SELECT jsonb_build_object('functions',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'triggers',(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal));"))
                    assert invariant_counts['functions'] > 0 and invariant_counts['triggers'] > 0, invariant_counts
                    sql(Path('scripts/django-migration/invariant-behavior.sql').read_text())
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
                print(json.dumps({'declared_schema_tables':table_count,'schema_source':'current src/lib/schema.js',
                                  'advanced_migration_invariants_qualified':False,'upgrade_coverage':False}))
                if '--invariants' in sys.argv:
                    print(json.dumps({'hierarchy_statements':len(statements['hierarchy']),
                                      'naming_statements':len(statements['naming']),
                                      'repeated_apply_passed':True,'catalog_counts':invariant_counts,
                                      'hierarchy_naming_behavior_cases':11,
                                      'complete_behavioral_invariants_qualified':False}))
        finally:
            for name in reversed(created):
                subprocess.run(docker + ['rm','--force',name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(docker + ['network','rm',network], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
