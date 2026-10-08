"""Real Next/Django HTTP comparison, restricted to disposable local qualification."""
import hashlib
import hmac
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from http.cookies import SimpleCookie
import urllib.request
import urllib.error
from urllib.parse import urlsplit, urlencode
import psycopg


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0))
        return s.getsockname()[1]


def token(version=0, age=0):
    def enc(v): return base64.urlsafe_b64encode(v).decode().rstrip('=')
    payload=enc(json.dumps({'uid':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ver':version,'exp':int(time.time()*1000)+2592000000-age}).encode())
    return payload+'.'+enc(hmac.new(os.environ['AUTH_SECRET'].encode(),payload.encode(),hashlib.sha256).digest())


def get(url,cookie,body=None,method=None,extra_headers=None):
    headers={'Cookie':'veevee_session='+cookie} if cookie else {}
    if extra_headers: headers.update(extra_headers)
    if body is not None: headers['Content-Type']='application/json'
    request=urllib.request.Request(url,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
    try: response=urllib.request.urlopen(request,timeout=20)
    except urllib.error.HTTPError as error: response=error
    return response.status,json.loads(response.read()),response.headers


def main():
    if '--gunicorn' in sys.argv and '--browser' in sys.argv:
        raise SystemExit('Production Secure-cookie browser qualification requires an HTTPS harness')
    target=urlsplit(os.environ.get('DATABASE_URL',''))
    if os.environ.get('MIGRATION_TEST_ISOLATED')!='1' or target.hostname!='127.0.0.1' or target.path!='/veevee_django_migration':
        raise SystemExit('Disposable loopback database required')
    if any(Path('.').glob('.env*')):
        raise SystemExit('Refusing checkout with dotenv files')
    root=Path.cwd()
    processes=[]
    with psycopg.connect(os.environ['DATABASE_URL'],autocommit=True) as db:
        with db.cursor() as c:
            c.execute('CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY,email text,name text,role text,color text,avatar_url text,is_active boolean,auth_version integer)')
            c.execute('CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY,value text NOT NULL,updated_at bigint NOT NULL)')
            c.execute('CREATE TABLE IF NOT EXISTS user_limits (user_id uuid,key text,value text NOT NULL,updated_at bigint NOT NULL,PRIMARY KEY(user_id,key))')
            c.execute('CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY,name text,brief text,created_by uuid,created_at bigint,updated_at bigint)')
            c.execute('CREATE TABLE IF NOT EXISTS folders (id uuid PRIMARY KEY,project_id uuid,parent_id uuid,name text,name_normalized text,version integer,color text,created_at bigint,updated_at bigint)')
            c.execute('CREATE TABLE IF NOT EXISTS generations (id uuid PRIMARY KEY,kind text NOT NULL,prompt text NOT NULL,project_id uuid,folder_id uuid,is_favorite boolean NOT NULL)')
            c.execute('TRUNCATE generations')
            for index, (kind,prompt,project,folder,favorite) in enumerate([
                ('image','100%_fixture\\ref','dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',True),
                ('video','100XXfixtureXref','dddddddd-dddd-4ddd-8ddd-dddddddddddd',None,False),
                ('depth','Depth fixture',None,None,True),
                ('audio','Audio fixture',None,None,True),
                ('image','Global fixture',None,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',False),
                ('image','a'*199+'�',None,None,False),
            ]):
                c.execute('INSERT INTO generations VALUES (%s,%s,%s,%s,%s,%s)',[f'aaaaaaaa-aaaa-4aaa-8aaa-{index:012d}',kind,prompt,project,folder,favorite])
            c.execute('CREATE TABLE IF NOT EXISTS canvas_boards (id uuid PRIMARY KEY,project_id uuid NOT NULL,name text NOT NULL,data jsonb NOT NULL,created_by uuid,created_at bigint NOT NULL,updated_at bigint NOT NULL)')
            c.execute('TRUNCATE canvas_boards')
            c.execute("INSERT INTO canvas_boards VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd','दृश्य','{\"private_graph\":\"fixture\"}',NULL,1,2)")
            c.execute('CREATE TABLE IF NOT EXISTS assets (id uuid PRIMARY KEY,kind text,name text,slug text,description text,images jsonb,project_id uuid,created_at bigint,updated_at bigint)')
            c.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text, ADD COLUMN IF NOT EXISTS password_salt text, ADD COLUMN IF NOT EXISTS created_at bigint')
            c.execute('CREATE TABLE IF NOT EXISTS login_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),identifier text NOT NULL,created_at bigint NOT NULL)')
            c.execute('CREATE TABLE IF NOT EXISTS activity_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,action text,detail jsonb,created_at bigint NOT NULL)')
            c.execute('TRUNCATE login_attempts,activity_logs')
            c.execute('ALTER TABLE projects ALTER COLUMN id SET DEFAULT gen_random_uuid()')
            c.execute('TRUNCATE users,settings,user_limits,folders,projects,assets')
            c.execute("INSERT INTO assets VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','character','Global','global',NULL,'[]',NULL,1,1),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','character','Project','project','Description','[\"/media/fixture.png\"]','dddddddd-dddd-4ddd-8ddd-dddddddddddd',2,2)")
            c.execute("INSERT INTO projects VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','Project',NULL,NULL,1,2)")
            c.execute("INSERT INTO folders VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',NULL,NULL,'Root','root',1,'blue',1,2),('cccccccc-cccc-4ccc-8ccc-cccccccccccc',NULL,'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Child','child',2,NULL,3,4)")
            c.execute("INSERT INTO users VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','fixture@example.invalid','Fixture','user',NULL,NULL,true,0)")
        def snapshot():
            with db.cursor() as c:
                result=[]
                for table in ('users','settings','user_limits','projects','folders','assets','canvas_boards','generations'):
                    c.execute('SELECT row_to_json(t)::text FROM '+table+' t ORDER BY 1')
                    result.append(c.fetchall())
                return result
        try:
            next_port,django_port=port(),port()
            django_command=[sys.executable,'backend/manage.py','runserver',f'127.0.0.1:{django_port}','--noreload']
            if '--gunicorn' in sys.argv:
                django_command=[sys.executable,'-m','gunicorn','--chdir','backend','config.wsgi:application','--bind',f'127.0.0.1:{django_port}','--workers','2','--error-logfile','-']
            for command,name in [(['node','node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',str(next_port)],'next'),(django_command,'django')]:
                log=open(root.parent/(name+'-settings-parity.log'),'w')
                server_env=dict(os.environ)
                if name=='django':
                    server_env['DJANGO_BROWSER_ORIGINS']='https://frontend.example'
                    if '--gunicorn' in sys.argv: server_env['DJANGO_SETTINGS_MODULE']='config.settings.production'
                processes.append((subprocess.Popen(command,env=server_env,stdout=log,stderr=subprocess.STDOUT),log))
            urls=[f'http://127.0.0.1:{p}/api/settings' for p in (next_port,django_port)]
            for url in urls:
                deadline=time.monotonic()+90
                while True:
                    try: get(url,'');break
                    except (OSError,ValueError):
                        if time.monotonic()>deadline: raise RuntimeError('Server readiness timed out')
                        if any(p.poll() is not None for p,_ in processes): raise RuntimeError('Server exited')
                        time.sleep(.2)
            health=get(f'http://127.0.0.1:{django_port}/api/health','')
            assert health[:2]==(200,{'ok':True,'django':'ready','database':'ready'})
            assert health[2].get('Cache-Control')=='no-store'
            cases=[('anonymous',''),('bad-signature','invalid'),('defaults',token()),('wrong-version',token(1)),('renewal',token(age=172800000)),('overrides',token()),('disabled',token())]
            report=[]
            for name,cookie in cases:
                with db.cursor() as c:
                    if name == 'overrides':
                        c.execute("INSERT INTO settings VALUES ('maxPromptLength','100',0),('maxConcurrentJobs','2',0)")
                        c.execute("INSERT INTO user_limits VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','maxPromptLength','invalid',0),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','maxConcurrentJobs','9tail',0)")
                    if name == 'disabled':
                        c.execute('UPDATE users SET is_active=false')
                before=snapshot()
                responses=[get(url,cookie) for url in urls]
                assert responses[0][:2]==responses[1][:2],(name,responses[0][:2],responses[1][:2])
                for status,body,headers in responses:
                    assert headers.get_content_type()=='application/json'
                    renewal=headers.get('Set-Cookie')
                    assert bool(renewal)==(name=='renewal'),(name,renewal)
                    if renewal:
                        flags = renewal.lower()
                        assert 'httponly' in flags and 'samesite=lax' in flags and 'path=/' in flags
                if name == 'renewal':
                    for issuer, (_, _, headers) in enumerate(responses):
                        jar = SimpleCookie()
                        jar.load(headers['Set-Cookie'])
                        renewed = jar['veevee_session'].value
                        assert jar['veevee_session']['max-age'] == '2592000'
                        # Both runtimes must accept either runtime's renewed cookie.
                        for destination in urls:
                            followup = get(destination, renewed)
                            assert followup[0] == 200
                            assert followup[1] == responses[issuer][1]
                            assert not followup[2].get('Set-Cookie')
                assert before==snapshot(),name+' mutated database'
                report.append({'case':name,'status':responses[0][0],'json_equal':True,'database_unchanged':True,'cookie_flags_equal':True})
            with db.cursor() as c:
                c.execute('UPDATE users SET is_active=true')
            with db.cursor() as c:
                c.execute("INSERT INTO folders VALUES ('ffffffff-ffff-4fff-8fff-ffffffffffff','dddddddd-dddd-4ddd-8ddd-dddddddddddd',NULL,'Project root','project root',1,'red',5,6)")
            import hashlib
            salt='synthetic-fixed-salt'
            password_hash=hashlib.scrypt(b'fixture-password',salt=salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=32*1024*1024).hex()
            with db.cursor() as c:
                c.execute('UPDATE users SET password_hash=%s,password_salt=%s,created_at=1',[password_hash,salt])
            login_report=[]
            for runtime,url in zip(('next','django'),urls):
                with db.cursor() as c:
                    c.execute('TRUNCATE login_attempts,activity_logs')
                login_url=url.replace('/api/settings','/api/auth/login')
                missing=get(login_url,'',{})
                assert missing[:2]==(400,{'error':'Email and password are required.'})
                success=get(login_url,'',{'email':' FIXTURE@EXAMPLE.INVALID ','password':'fixture-password'})
                assert success[0]==200 and success[1]['user']['email']=='fixture@example.invalid'
                jar=SimpleCookie();jar.load(success[2]['Set-Cookie'])
                assert jar['veevee_session']['httponly'] and jar['veevee_session']['samesite'].lower()=='lax'
                assert str(jar['veevee_session']['max-age'])=='2592000'
                if runtime=='django' and '--gunicorn' in sys.argv: assert jar['veevee_session']['secure']
                for target_url in urls:
                    assert get(target_url,jar['veevee_session'].value)[0]==200
                for attempt in range(5):
                    failure=get(login_url,'',{'email':'missing@example.invalid','password':'wrong'})
                    assert failure[:2]==(401,{'error':'Invalid email or password.'})
                blocked=get(login_url,'',{'email':'missing@example.invalid','password':'wrong'})
                assert blocked[:2]==(429,{'error':'Too many failed attempts. Try again later.'})
                assert 895 <= int(blocked[2]['Retry-After']) <= 900
                with db.cursor() as c:
                    c.execute('SELECT identifier,count(*) FROM login_attempts GROUP BY identifier')
                    assert c.fetchall()==[('missing@example.invalid',5)]
                    c.execute('SELECT user_id::text,action,detail FROM activity_logs')
                    assert c.fetchall()==[('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','login',None)]
                logout_url=url.replace('/api/settings','/api/auth/logout')
                for cookie in ['',jar['veevee_session'].value]:
                    logged_out=get(logout_url,cookie,{})
                    assert logged_out[:2]==(200,{'ok':True})
                    cleared=SimpleCookie();cleared.load(logged_out[2]['Set-Cookie'])
                    assert cleared['veevee_session'].value==''
                    assert str(cleared['veevee_session']['max-age'])=='0'
                    assert cleared['veevee_session']['httponly']
                    assert cleared['veevee_session']['path']=='/'
                    assert not cleared['veevee_session']['samesite']
                with db.cursor() as c:
                    c.execute("SELECT count(*) FROM activity_logs WHERE action='logout'")
                    assert c.fetchone()[0]==1
                login_report.append({'runtime':runtime,'success_cookie_interoperable':True,'failure_throttle_audit_contract':True,'logout_cookie_audit_contract':True})
            project_report = []
            for name,cookie in [('anonymous',''),('authenticated',token())]:
                before=snapshot()
                responses=[get(url.replace('/api/settings','/api/projects'),cookie) for url in urls]
                assert responses[0][:2]==responses[1][:2],('projects',name,responses[0][:2],responses[1][:2])
                assert before==snapshot(),'populated project read mutated DB'
                project_report.append({'case':name,'status':responses[0][0],'json_equal':True,'database_unchanged':True})
            me_report = []
            for name, cookie in [('anonymous',''),('invalid','invalid'),('authenticated',token()),('wrong-version',token(1)),('renewal',token(age=172800000))]:
                before = snapshot()
                responses = [get(url.replace('/api/settings','/api/auth/me'),cookie) for url in urls]
                assert responses[0][:2] == responses[1][:2], ('me',name,responses[0][:2],responses[1][:2])
                cookies=[]
                for _,_,headers in responses:
                    jar=SimpleCookie()
                    if headers.get('Set-Cookie'): jar.load(headers['Set-Cookie'])
                    cookies.append(jar)
                assert bool(cookies[0]) == bool(cookies[1])
                for jar in cookies:
                    if jar:
                        expected='0' if name in ('anonymous','invalid','wrong-version') else '2592000'
                        assert str(jar['veevee_session']['max-age']) == expected
                        assert jar['veevee_session']['httponly']
                        assert jar['veevee_session']['samesite'].lower() == 'lax'
                assert before == snapshot(), 'me read mutated DB'
                me_report.append({'case':name,'status':responses[0][0],'json_equal':True,'cookie_contract_equal':True,'database_unchanged':True})
            folder_report = []
            for query in ['', '?tree=1', '?tree=true&ancestry=cccccccc-cccc-4ccc-8ccc-cccccccccccc', '?parentId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd', '?projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd', '?ancestry=cccccccc-cccc-4ccc-8ccc-cccccccccccc', '?ancestry=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '?tree=1&tree=0', '?parentId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&parentId=dddddddd-dddd-4ddd-8ddd-dddddddddddd']:
                before = snapshot()
                responses = [get(url.replace('/api/settings','/api/folders')+query, token()) for url in urls]
                assert responses[0][:2] == responses[1][:2], (query, responses[0][:2], responses[1][:2])
                assert before == snapshot(), 'folder read mutated DB'
                folder_report.append({'query':query,'status':responses[0][0],'json_equal':True,'database_unchanged':True})
            asset_report = []
            for query, cookie in [('', ''), ('', token()), ('?projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd',token()), ('?projectId=&projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd',token()), ('?projectId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',token())]:
                before = snapshot()
                responses = [get(url.replace('/api/settings','/api/assets')+query,cookie) for url in urls]
                assert responses[0][:2] == responses[1][:2], ('assets',query,responses[0][:2],responses[1][:2])
                assert before == snapshot(), 'asset read mutated DB'
                asset_report.append({'query':query,'authenticated':bool(cookie),'status':responses[0][0],'json_equal':True,'database_unchanged':True})
            canvas_report = []
            for query, cookie in [('', ''), ('', token()), ('?projectId=', token()),
                    ('?projectId=&projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd', token()),
                    ('?projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd', token()),
                    ('?projectId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', token()),
                    ('?projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd&projectId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', token(age=172800000)),
                    ('', token(age=172800000))]:
                before = snapshot()
                responses = [get(url.replace('/api/settings','/api/canvas-boards')+query,cookie) for url in urls]
                assert responses[0][:2] == responses[1][:2], ('canvas',query,responses[0][:2],responses[1][:2])
                jars = []
                for _, body, headers in responses:
                    assert headers.get('Content-Type','').startswith('application/json')
                    assert all('data' not in row for row in body.get('boards',[]))
                    jar = SimpleCookie(headers.get('Set-Cookie',''))
                    jars.append(jar)
                assert bool(jars[0]) == bool(jars[1]), ('canvas renewal',query)
                for jar in jars:
                    if jar:
                        value = jar['veevee_session']
                        assert value['max-age']=='2592000' and value['httponly'] and value['samesite'].lower()=='lax' and value['path']=='/'
                assert before == snapshot(), 'canvas read mutated DB'
                canvas_report.append({'query':query,'status':responses[0][0],'json_equal':True,'cookie_contract_equal':True,'database_unchanged':True})
            history_count_report = []
            for query,cookie in [('', ''),('', token()),
                    ('?projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd&folderId=none&favorite=1', token(age=172800000)),
                    ('?projectId=none&kind=audio',token()),('?kind=depth',token()),
                    ('?projectId=&projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd&kind=audio&kind=image',token()),
                    ('?'+urlencode({'q':'\ufeff100%_fixture\\ref\ufeff'}),token()),
                    ('?'+urlencode({'q':'a'*199+'😀tail'}),token())]:
                before = snapshot()
                responses = [get(url.replace('/api/settings','/api/history/counts')+query,cookie) for url in urls]
                assert responses[0][:2] == responses[1][:2], ('history counts',query,responses[0][:2],responses[1][:2])
                jars = [SimpleCookie(response[2].get('Set-Cookie','')) for response in responses]
                assert bool(jars[0]) == bool(jars[1]), ('history count renewal',query)
                assert before == snapshot(), 'history counts mutated DB'
                history_count_report.append({'query':query,'status':responses[0][0],'json_equal':True,'renewal_presence_equal':True,'database_unchanged':True})
            origin_report=[]
            before=snapshot()
            with db.cursor() as c:
                c.execute('SELECT count(*) FROM login_attempts')
                attempts_before=c.fetchone()[0]
                c.execute('SELECT count(*) FROM activity_logs')
                audit_before=c.fetchone()[0]
            for path,method in [('/api/auth/login','POST'),('/api/auth/logout','POST'),('/api/auth/password','PATCH')]:
                endpoint=urls[1].replace('/api/settings',path)
                for headers in [{'Origin':'https://attacker.example'},{'Origin':'null'},{'Sec-Fetch-Site':'cross-site'}]:
                    rejected=get(endpoint,token(),{},method=method,extra_headers=headers)
                    assert rejected[:2]==(403,{'error':'FORBIDDEN_ORIGIN'})
                origin_report.append({'route':path,'untrusted_null_cross_site_rejected':True})
            trusted=get(urls[1].replace('/api/settings','/api/auth/login'),'',{},extra_headers={'Origin':'https://frontend.example'})
            assert trusted[:2]==(400,{'error':'Email and password are required.'})
            assert before==snapshot(),'Origin denial mutated application DB'
            with db.cursor() as c:
                c.execute('SELECT count(*) FROM login_attempts')
                assert c.fetchone()[0]==attempts_before
                c.execute('SELECT count(*) FROM activity_logs')
                assert c.fetchone()[0]==audit_before
            password_report=[]
            for runtime,url in zip(('next','django'),urls):
                with db.cursor() as c:
                    c.execute('UPDATE users SET password_hash=%s,password_salt=%s,auth_version=0,is_active=true',[password_hash,salt])
                    c.execute('TRUNCATE activity_logs')
                endpoint=url.replace('/api/settings','/api/auth/password')
                old_cookie=token()
                wrong=get(endpoint,old_cookie,{'currentPassword':'wrong','newPassword':'changed-fixture-password'},method='PATCH')
                assert wrong[:2]==(401,{'error':'Current password is incorrect.'})
                with db.cursor() as c:
                    c.execute('SELECT auth_version,password_hash FROM users')
                    assert c.fetchone()==(0,password_hash)
                changed=get(endpoint,old_cookie,{'currentPassword':'fixture-password','newPassword':'changed-fixture-password'},method='PATCH')
                assert changed[:2]==(200,{'ok':True})
                jar=SimpleCookie();jar.load(changed[2]['Set-Cookie'])
                assert str(jar['veevee_session']['max-age'])=='2592000'
                if runtime=='django' and '--gunicorn' in sys.argv: assert jar['veevee_session']['secure']
                assert jar['veevee_session']['httponly'] and jar['veevee_session']['samesite'].lower()=='lax'
                for target_url in urls:
                    assert get(target_url,old_cookie)[0]==401
                    assert get(target_url,jar['veevee_session'].value)[0]==200
                with db.cursor() as c:
                    c.execute('SELECT auth_version,password_hash,password_salt FROM users')
                    version,stored_hash,stored_salt=c.fetchone()
                    assert version==1
                    candidate=hashlib.scrypt(b'changed-fixture-password',salt=stored_salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=32*1024*1024).hex()
                    assert candidate==stored_hash
                    c.execute('SELECT user_id::text,action,detail FROM activity_logs')
                    assert c.fetchall()==[('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','password_changed',None)]
                password_report.append({'runtime':runtime,'old_token_rejected_by_both':True,'new_token_accepted_by_both':True,'hash_version_audit_contract':True})
            with db.cursor() as c:
                c.execute('UPDATE users SET password_hash=%s,password_salt=%s,auth_version=0',[password_hash,salt])
                c.execute('TRUNCATE activity_logs')
            from concurrent.futures import ThreadPoolExecutor
            original_cookie=token()
            def competing_change(index):
                return get(urls[index].replace('/api/settings','/api/auth/password'),original_cookie,
                           {'currentPassword':'fixture-password','newPassword':f'competing-password-{index}'},method='PATCH')
            with ThreadPoolExecutor(max_workers=2) as pool:
                competing=list(pool.map(competing_change,range(2)))
            statuses=[result[0] for result in competing]
            assert statuses.count(200)==1 and all(status in (200,401,409) for status in statuses), statuses
            winner=statuses.index(200)
            with db.cursor() as c:
                c.execute('SELECT auth_version,password_hash,password_salt FROM users')
                version,stored_hash,stored_salt=c.fetchone()
                assert version==1
                candidate=hashlib.scrypt(f'competing-password-{winner}'.encode(),salt=stored_salt.encode(),n=16384,r=8,p=1,dklen=64,maxmem=32*1024*1024).hex()
                assert candidate==stored_hash
                c.execute("SELECT count(*) FROM activity_logs WHERE action='password_changed'")
                assert c.fetchone()[0]==1
                c.execute('UPDATE users SET auth_version=0')
            default_project_report=[]
            for runtime,url in zip(('next','django'),urls):
                with db.cursor() as c:
                    c.execute('TRUNCATE folders,projects')
                response=get(url.replace('/api/settings','/api/projects'),token())
                assert response[0]==200
                created=response[1]['projects']
                assert len(created)==1 and created[0]['name']=='My Project'
                assert created[0]['folders']==[] and 'brief' not in created[0]
                assert created[0]['createdAt']==created[0]['updatedAt']
                from uuid import UUID
                UUID(created[0]['id'])
                with db.cursor() as c:
                    c.execute('SELECT id::text,name,brief,created_by,created_at,updated_at FROM projects')
                    rows=c.fetchall()
                assert len(rows)==1 and rows[0][0]==created[0]['id']
                assert rows[0][2:4]==(None,None)
                before=snapshot()
                assert get(url.replace('/api/settings','/api/projects'),token())[:2]==response[:2]
                assert before==snapshot()
                default_project_report.append({'runtime':runtime,'one_default':True,'repeat_read_unchanged':True})
            with db.cursor() as c:
                c.execute('TRUNCATE folders,projects')
            from concurrent.futures import ThreadPoolExecutor
            def mixed_read(index):
                response=get(urls[index % 2].replace('/api/settings','/api/projects'),token())
                assert response[0]==200 and len(response[1]['projects'])==1
                return response[1]['projects'][0]['id']
            with ThreadPoolExecutor(max_workers=6) as pool:
                ids=list(pool.map(mixed_read,range(12)))
            assert len(set(ids))==1, 'cross-runtime duplicate default projects'
            with db.cursor() as c:
                c.execute('SELECT count(*) FROM projects')
                assert c.fetchone()[0]==1
            # Reuse the actual Next process after restarting with server-side
            # method routing; its retained Node route must be bypassed.
            next_process, next_log = processes[0]
            next_process.terminate()
            next_process.wait(timeout=10)
            routed_env = dict(os.environ, DJANGO_API_METHODS='GET /api/settings, GET /api/canvas-boards',
                              DJANGO_API_ORIGIN=f'http://127.0.0.1:{django_port}',
                              DJANGO_API_ALLOW_LOCAL='1')
            routed = subprocess.Popen(['node','node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',str(next_port)], env=routed_env, stdout=next_log, stderr=subprocess.STDOUT)
            processes.append((routed, open(os.devnull, 'w')))
            with db.cursor() as c:
                c.execute('UPDATE users SET is_active=true')
            deadline = time.monotonic()+90
            while True:
                try:
                    response = get(urls[0], token())
                    if response[0] == 200: break
                except OSError:
                    pass
                if routed.poll() is not None or time.monotonic()>deadline:
                    raise RuntimeError('Routed Next readiness failed')
                time.sleep(.2)
            assert response[:2] == get(urls[1], token())[:2]
            assert response[2].get('X-Request-ID'), 'Django request ID proves rewrite reached Django'
            browser_report = 'not_run'
            if '--browser' in sys.argv:
                result=subprocess.run(['node','scripts/django-migration/settings-browser.mjs'],input=json.dumps({'url':urls[0],'cookie':token(age=172800000),'expected':response[1], 'extraCases':[{'path':'/api/canvas-boards','status':400,'expected':{'error':'projectId required.'}},{'path':'/api/canvas-boards?projectId=dddddddd-dddd-4ddd-8ddd-dddddddddddd','status':200,'expected':{'boards':[{'id':'cccccccc-cccc-4ccc-8ccc-cccccccccccc','projectId':'dddddddd-dddd-4ddd-8ddd-dddddddddddd','name':'दृश्य','createdBy':None,'createdAt':1,'updatedAt':2}]}}]}),text=True,capture_output=True)
                if result.returncode:
                    raise RuntimeError(result.stderr[-4000:])
                browser_report=json.loads(result.stdout)
            print(json.dumps({'django_runtime':'gunicorn_production' if '--gunicorn' in sys.argv else 'runserver_test','browser_settings_contract':browser_report,'settings_http_parity':report, 'same_origin_rewrite': 'passed', 'folder_http_parity': folder_report, 'asset_http_parity': asset_report, 'canvas_metadata_http_parity': canvas_report, 'history_counts_http_parity':history_count_report, 'current_user_http_parity': me_report, 'project_http_parity':project_report,'empty_project_contract':default_project_report,'mixed_runtime_default_creation':'passed','login_http_contract':login_report,'password_http_contract':password_report,'origin_security_contract':origin_report,'mixed_runtime_password_update':'one_winner'},indent=2))
        finally:
            for process,log in processes:
                process.terminate()
            for process,log in processes:
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill();process.wait()
                log.close()

if __name__=='__main__': main()
