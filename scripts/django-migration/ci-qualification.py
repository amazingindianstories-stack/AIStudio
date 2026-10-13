"""Linux CI qualification with inspected disposable targets and an empty home.

Only GitHub-hosted job service containers are accepted. No inherited database,
provider, cloud, proxy, preload or checkout dotenv configuration reaches children.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
DB_NAME = 'veevee_django_migration'
DB_USER = 'migration'
DB_PASSWORD = 'disposable-ci-only'


def require(value, message):
    if not value: raise RuntimeError(message)


def validate_target(container, network, *, container_id, network_id, port):
    require(container['Id'] == container_id, 'Service container identity mismatch')
    require(container['Config']['Image'] == 'postgres:16', 'PostgreSQL 16 service image required')
    require(container['State']['Running'] and container['State'].get('Health',{}).get('Status')=='healthy', 'Service is not running and healthy')
    require(not container['HostConfig'].get('Privileged'), 'Privileged database service refused')
    links=container['NetworkSettings']['Networks']
    require(len(links)==1 and next(iter(links.values()))['NetworkID']==network_id, 'Unexpected service network')
    require(network['Id']==network_id and network['Driver']=='bridge', 'Job bridge network identity mismatch')
    require(container_id in network.get('Containers',{}), 'Database is outside the job network')
    mounts=container.get('Mounts',[])
    require(len(mounts)==1 and mounts[0]['Type']=='tmpfs' and mounts[0]['Destination']=='/var/lib/postgresql/data', 'Only disposable tmpfs PostgreSQL data is allowed')
    bindings=container['NetworkSettings']['Ports'].get('5432/tcp') or []
    require(bindings and all(int(binding['HostPort'])==port and binding['HostIp'] in ('0.0.0.0','127.0.0.1','::','::1') for binding in bindings), 'Published database port mismatch')
    values=dict(value.split('=',1) for value in container['Config'].get('Env',[]) if '=' in value)
    require(all(values.get(key)==value for key,value in {'POSTGRES_USER':DB_USER,'POSTGRES_PASSWORD':DB_PASSWORD,'POSTGRES_DB':DB_NAME}.items()), 'Unexpected service database configuration')
    return next(iter(links.values()))['IPAddress']


def safe_environment(session):
    paths=[str(Path(sys.executable).parent)]
    node=shutil.which('node')
    if node: paths.append(str(Path(node).parent))
    paths.extend(['/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'])
    return {'PATH':':'.join(dict.fromkeys(paths)),'HOME':str(session/'home'),'TMPDIR':str(session/'tmp'),
        'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','CI':'1','NEXT_TELEMETRY_DISABLED':'1',
        'AWS_EC2_METADATA_DISABLED':'true','ENV_FILE':str(session/'empty.env')}


def clean_copy(session,env):
    target=session/'repo';target.mkdir()
    roots={'src','scripts','tests','backend','docs','.github','public'}
    files={'package.json','package-lock.json','jsconfig.json','next.config.js','eslint.config.mjs','playwright.config.mjs',
        'postcss.config.js','tailwind.config.js','vercel.json','AGENTS.md','CLAUDE.md','DEPLOYMENT_RUNBOOK.md',
        'BACKEND_AUDIT.md','progress.md','.gitignore','Veevee_Django_Migration_Blueprint_2026-10-08.md',
        'Dockerfile.worker','Dockerfile.worker.dockerignore','railway.toml'}
    names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT,env=env).decode().split('\0')
    for name in names:
        path=Path(name)
        if not name or (path.parts[0] not in roots and name not in files): continue
        if path.parts[0]=='public' and name!='public/logo.png' and path.name!='.gitkeep': continue
        if any(part.startswith('.env') or part in ('__pycache__','.venv','venv','support','screenshots') for part in path.parts): continue
        source=ROOT/path
        if not source.is_file() or source.is_symlink(): continue
        destination=target/path;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,destination)
    require(not any(target.glob('.env*')), 'Credential environment files entered clean source')
    # Dependencies contain package code only; all generated files remain isolated.
    if (ROOT/'node_modules').is_dir(): (target/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
    subprocess.run(['git','init','--quiet'],cwd=target,env=env,check=True)
    subprocess.run(['git','add','--all','--force'],cwd=target,env=env,check=True)
    return target


class Qualification:
    def __init__(self,args,session,env,root):
        self.args,self.session,self.env,self.root=args,session,env,root
        self.docker=['docker','--config',str(session/'docker-config')]
        (session/'docker-config').mkdir()
        self.ip=None

    def command(self,command,*,capture=False,input=None,env=None):
        result=subprocess.run(command,cwd=self.root,env=env or self.env,input=input,text=True,
            stdout=subprocess.PIPE if capture else None,stderr=subprocess.PIPE if capture else None)
        require(result.returncode==0,'Qualification command failed: '+command[0])
        return result.stdout.strip() if capture else None

    def verify(self):
        container=json.loads(self.command(self.docker+['inspect',self.args.postgres_container],capture=True))[0]
        network=json.loads(self.command(self.docker+['network','inspect',self.args.network],capture=True))[0]
        self.ip=validate_target(container,network,container_id=self.args.postgres_container,network_id=network['Id'],port=self.args.port)
        # The context may provide a network name; docker resolves it to an ID,
        # then the service's actual network must match that resolved network.
        version=self.command(self.docker+['exec',self.args.postgres_container,'psql','-U',DB_USER,'-d',DB_NAME,'-Atc','SHOW server_version'],capture=True)
        require(version.startswith('16.'),'Actual database server is not PostgreSQL 16')
        print(json.dumps({'target_verified':True,'postgres_major':16,'mount':'tmpfs','credential_home':'empty','source':'allowlisted copy'}),flush=True)

    def python(self,*args):
        self.verify()
        return self.command([sys.executable,*args])

    def baseline(self):
        self.verify()
        sys.path.insert(0,str(self.root/'scripts/django-migration'))
        from frozen_oracle import schema_sql, check_output as oracle_output
        spec=importlib.util.spec_from_file_location('ci_catalog',self.root/'scripts/django-migration/schema-catalog.py')
        catalog=importlib.util.module_from_spec(spec);spec.loader.exec_module(catalog)
        image='veevee-ci-api:'+str(os.getpid())
        digest=hashlib.sha256()
        for path in sorted((self.root/'backend').rglob('*')):
            if not path.is_file() or path.is_symlink() or '__pycache__' in path.parts: continue
            if path.suffix!='.py' and not (path.suffix=='.json' and 'testsupport/goldens' in path.as_posix()) and path.name not in {'requirements.txt','constraints-qualified.txt','Dockerfile','Dockerfile.dockerignore'}: continue
            digest.update(path.relative_to(self.root).as_posix().encode()+b'\0'+hashlib.sha256(path.read_bytes()).digest())
        fingerprint=digest.hexdigest()
        self.command(self.docker+['build','--file','backend/Dockerfile','--tag',image,
            '--label','org.opencontainers.image.revision='+self.env['VEEVEE_SOURCE_REVISION'],
            '--label','io.veevee.api-source-sha256='+fingerprint,'.'])
        metadata=json.loads(self.command(self.docker+['image','inspect',image],capture=True))[0]
        require(metadata['Config']['Labels']['io.veevee.api-source-sha256']==fingerprint,'Image/source fingerprint mismatch')
        identity={'image_id':metadata['Id'],'architecture':metadata['Architecture'],
            'source_revision':self.env['VEEVEE_SOURCE_REVISION'],'api_source_sha256':fingerprint,
            'default_command':metadata['Config']['Cmd'],'scope':'local GitHub job image; not hosted deployment'}
        (self.session/'ci-image-identity.json').write_text(json.dumps(identity,indent=2)+'\n')
        def sql(statement,database=DB_NAME):
            self.command(self.docker+['exec','--interactive',self.args.postgres_container,'psql','-U',DB_USER,'-d',database,'-v','ON_ERROR_STOP=1','-q'],input=statement)
        def probe(filename,payload,database=DB_NAME):
            alias='veevee-qualification-pg-ci'
            values={'DATABASE_URL':f'postgresql://{DB_USER}:{DB_PASSWORD}@{alias}:5432/{database}',
                'DJANGO_SECRET_KEY':'disposable-ci-framework-secret','AUTH_SECRET':'disposable-ci-cookie-secret',
                'DJANGO_ALLOWED_HOSTS':'127.0.0.1','DJANGO_BROWSER_ORIGINS':'https://frontend.example',
                'VEEVEE_BASELINE_TEST':'1','VEEVEE_GENERATION_PERSISTENCE_TEST':'1','MOCK_GENERATION':'1'}
            command=self.docker+['run','--rm','--interactive','--network',self.args.network,'--add-host',alias+':'+self.ip,
                '--entrypoint','python']
            for key,value in values.items(): command+=['--env',key+'='+value]
            source=(self.root/'scripts/django-migration'/filename).read_text()
            return json.loads(self.command(command+[image,'-c',source],input=json.dumps(payload),capture=True))
        sql(schema_sql())
        statements=json.loads(oracle_output(['node','--import','tsx','scripts/django-migration/invariant-statements.mjs'],text=True))
        for _ in range(2):
            for domain in ('hierarchy','naming'): sql('BEGIN;\n'+';\n'.join(statements[domain])+';\nCOMMIT;')
        checks=json.loads(oracle_output(['node','scripts/django-migration/declared-checks.mjs'],text=True))
        color=next(row for row in checks if row['name']=='folders_color_check')
        sql(f'ALTER TABLE folders ADD CONSTRAINT folders_color_check CHECK ({color["sql"]});')
        self.command(self.docker+['exec',self.args.postgres_container,'createdb','-U',DB_USER,'veevee_django_baseline'])
        current=probe('baseline-container-probe.py',{'queries':catalog.QUERIES})
        fresh=probe('baseline-container-probe.py',{'queries':catalog.QUERIES},'veevee_django_baseline')
        differences=catalog.compare(current['catalog'],fresh['catalog'])
        require(not differences,'Fresh Django schema differs from historical frozen catalog')
        behavior=(self.root/'scripts/django-migration/invariant-behavior.sql').read_text()
        sql(behavior);sql(behavior,'veevee_django_baseline')
        probe('generation-persistence-probe.py',{},'veevee_django_baseline')
        adoption=probe('baseline-adoption-probe.py',{'queries':catalog.QUERIES,'expected_catalog':fresh['catalog'],
            'legacy_history':json.loads((self.root/'docs/django-migration/transitional-migration-history.json').read_text())['migrations'],
            'populated_fixture_source':(self.root/'scripts/django-migration/populated-adoption-fixture.py').read_text()})
        upgrades={}
        for database in (DB_NAME,'veevee_django_baseline'):
            upgrade=probe('additive-upgrade-probe.py',{'queries':catalog.QUERIES},database)
            require(upgrade['application_rows_preserved'] and upgrade['exact_additive_catalog_verified'],'Additive migration upgrade lost rows or catalog')
            upgrades[database]=upgrade
        evidence={'postgres_major':16,'fresh_schema_equivalent':True,'committed_migrations':fresh['committed_migrations'],'populated_adoption':adoption,'additive_upgrades':upgrades,'image_identity':identity}
        (self.session/'pg16-baseline-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
        print(json.dumps(evidence),flush=True)
        # Recreate only this inspected disposable database for ordinary fresh
        # migration and browser fixtures; no shared/production target is accepted.
        self.command(self.docker+['exec',self.args.postgres_container,'dropdb','-U',DB_USER,DB_NAME])
        self.command(self.docker+['exec',self.args.postgres_container,'createdb','-U',DB_USER,DB_NAME])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('suite',choices=('web','backend','browser'))
    parser.add_argument('--postgres-container')
    parser.add_argument('--network')
    parser.add_argument('--port',type=int)
    args=parser.parse_args()
    require(os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted','Only GitHub-hosted qualification jobs are allowed')
    if args.suite!='web':
        require(args.postgres_container and re.fullmatch('[a-f0-9]{64}',args.postgres_container),'Explicit GitHub service container ID required')
        require(args.network and args.port and 0<args.port<65536,'Explicit GitHub service network and published port required')
    runner_tmp=Path(os.environ['RUNNER_TEMP']).resolve()
    session=Path(tempfile.mkdtemp(prefix='veevee-ci-',dir=runner_tmp))
    for name in ('home','tmp'): (session/name).mkdir()
    (session/'empty.env').touch()
    env=safe_environment(session)
    root=clean_copy(session,env)
    revision=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,env=env,text=True).strip()
    if args.suite!='web':
        env.update(DATABASE_URL=f'postgresql://{DB_USER}:{DB_PASSWORD}@127.0.0.1:{args.port}/{DB_NAME}',DATABASE_BACKEND='postgres',
            AUTH_SECRET='disposable-ci-cookie-secret',DJANGO_SECRET_KEY='disposable-ci-framework-secret',
            DJANGO_SETTINGS_MODULE='config.settings.test',MIGRATION_TEST_ISOLATED='1',MOCK_GENERATION='1',MOCK_ASSET_PROVIDER='1',
            DJANGO_ALLOWED_HOSTS='127.0.0.1,localhost,testserver',VEEVEE_SOURCE_REVISION=revision)
    qualification=Qualification(args,session,env,root)
    artifacts=runner_tmp/'veevee-ci-artifacts'
    artifacts.mkdir(exist_ok=True)
    try:
        if args.suite=='web':
            for command in (['npm','run','check:backend-ownership'],['npm','run','check:migration-status'],['npm','audit','--omit=dev'],['npm','run','lint'],['npm','test'],['npm','run','build']): qualification.command(command)
            qualification.command([sys.executable,'scripts/django-migration/goal3-infrastructure-check.py'])
            qualification.command([sys.executable,'-m','unittest','discover','-s','scripts/django-migration','-p','test_goal*.py'])
            # Advisory-only full dependency tree; production audit above remains
            # a hard gate. No blindly applied major upgrades for build tooling.
            clean_env={**env,'MIGRATION_TEST_ISOLATED':'1'}
            qualification.command([sys.executable,'scripts/django-migration/goal3-dependency-audit.py'],env=clean_env)
            qualification.command([sys.executable,'scripts/django-migration/goal3-package-dry-run.py'],env=clean_env)
        elif args.suite=='backend':
            qualification.baseline()
            # Running manage.py test from the repository root without labels
            # discovers zero apps. Keep every application and golden suite explicit.
            labels=('apps.common','apps.admin_dashboard','apps.library','apps.assets','apps.authentication',
                    'apps.projects','apps.canvas','apps.agents','apps.generation','apps.exports','apps.workers','apps.media','testsupport')
            for command in [('check',),('makemigrations','--check','--dry-run'),('migrate','--noinput'),('test',*labels,'--noinput','--verbosity','1')]:
                qualification.python('backend/manage.py',*command)
            qualification.python('scripts/django-migration/schema-reproduction-probe.py','--require-equivalent')
            qualification.python('scripts/django-migration/schema-reproduction-probe.py','--migration-executor','--require-equivalent')
            qualification.python('-m','unittest','discover','-s','scripts/django-migration','-p','test_*.py')
        else:
            qualification.verify()
            qualification.command(['node','node_modules/@playwright/test/cli.js','install','chromium'])
            qualification.python('scripts/django-migration/browser-harness.py')
    finally:
        for source in (session/'pg16-baseline-evidence.json',session/'ci-image-identity.json',session/'tmp/browser-qualification',root/'test-results',root/'playwright-report'):
            if source.is_dir(): shutil.copytree(source,artifacts/source.name,dirs_exist_ok=True)
            elif source.is_file(): shutil.copy2(source,artifacts/source.name)


if __name__=='__main__': main()
