"""Offline package/base inventory for explicitly qualified local images."""
import json, os, subprocess, tempfile
from pathlib import Path
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified isolation runner required')
probe = '''import importlib.metadata,json,platform,subprocess
print(json.dumps({'python':platform.python_version(),'architecture':platform.machine(),
'python_packages':sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions()],key=lambda d:d['name'].lower()),
'os_packages':subprocess.check_output(['dpkg-query','-W','--showformat=${Package}\\t${Version}\\n'],text=True).splitlines(),
'ffmpeg':subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0]}))'''
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as config:
    Path(config,'config.json').write_text('{}')
    docker=['docker','--config',config,'--host','unix:///Users/ais4/.docker/run/docker.sock']
    result={'format':'Local build-to-test package inventory; not a signed standards-certified SBOM','roles':{}}
    for role,image in [('api','veevee-django-qualification:local'),('workers','veevee-django-worker-qualification:local')]:
        metadata=json.loads(subprocess.check_output(docker+['image','inspect',image],text=True))[0]
        packages=json.loads(subprocess.check_output(docker+['run','--rm','--network','none','--entrypoint','python',image,'-c',probe],text=True))
        result['roles'][role]={**packages,'image_id':metadata['Id'],'source_labels':metadata['Config']['Labels'],
                              'default_command':metadata['Config']['Cmd'],'rootfs_layers':metadata['RootFS']['Layers']}
    assert result['roles']['api']['python_packages']==result['roles']['workers']['python_packages']
    assert result['roles']['api']['os_packages']==result['roles']['workers']['os_packages']
    result['role_package_parity']=True
    print(json.dumps(result,indent=2))
