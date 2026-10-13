"""Public digest lineage and isolated amd64 native dependency smoke; never push."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified isolation required')
probe = '''import hashlib,importlib.metadata,json,platform,subprocess
import pyvips
image=pyvips.Image.black(16,16).new_from_image([5,20,35])
png=image.write_to_buffer('.png')
assert pyvips.Image.new_from_buffer(png,'').width==16
print(json.dumps({'architecture':platform.machine(),'python':platform.python_version(),
'packages':sorted([(d.metadata['Name'],d.version) for d in importlib.metadata.distributions()]),
'vips_version':[pyvips.version(i) for i in range(3)],'vips_png_sha256':hashlib.sha256(png).hexdigest(),
'ffmpeg':subprocess.check_output(['ffmpeg','-version'],text=True).splitlines()[0]}))'''
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as config:
    Path(config, 'config.json').write_text(json.dumps({'cliPluginsExtraDirs': ['/Applications/Docker.app/Contents/Resources/cli-plugins']}))
    docker = ['docker', '--config', config, '--host', 'unix:///Users/ais4/.docker/run/docker.sock']
    base = re.search(r'^FROM (.+)$', Path('backend/Dockerfile').read_text(), re.M).group(1)
    manifest = json.loads(subprocess.check_output(docker + ['buildx', 'imagetools', 'inspect', '--raw', base], text=True))
    platforms = {item['platform']['architecture']: item['digest'] for item in manifest['manifests'] if item['platform'].get('os') == 'linux'}
    assert {'amd64', 'arm64'} <= platforms.keys()
    tag = 'veevee-goal3-e-amd64:local'
    subprocess.run(docker + ['buildx', 'build', '--load', '--platform', 'linux/amd64', '--file', 'backend/Dockerfile', '--tag', tag, '.'], check=True)
    result = {'base': base, 'platform_manifest_digests': platforms, 'roles': {},
              'scope': 'local platform smoke and public image metadata; immutable final tested image promotion required'}
    for architecture, image in [('amd64', tag), ('arm64', 'veevee-django-qualification:local')]:
        metadata = json.loads(subprocess.check_output(docker + ['image', 'inspect', image], text=True))[0]
        assert metadata['Architecture'] == architecture
        data = json.loads(subprocess.check_output(docker + ['run', '--rm', '--network', 'none', '--platform', 'linux/' + architecture,
                    '--entrypoint', 'python', metadata['Id'], '-c', probe], text=True))
        result['roles'][architecture] = {**data, 'image_id': metadata['Id'], 'source_labels': metadata['Config'].get('Labels')}
    assert result['roles']['amd64']['packages'] == result['roles']['arm64']['packages'], 'Python lock drift across architectures'
    assert result['roles']['amd64']['vips_version'] == result['roles']['arm64']['vips_version'], 'Native ABI version drift'
    assert result['roles']['amd64']['ffmpeg'] == result['roles']['arm64']['ffmpeg'], 'FFmpeg package version drift'
    assert result['roles']['amd64']['vips_png_sha256'] == result['roles']['arm64']['vips_png_sha256'], 'Native output drift'
    print(json.dumps(result, indent=2))
