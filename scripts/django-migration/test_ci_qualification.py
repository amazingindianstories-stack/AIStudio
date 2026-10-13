import copy
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('ci_qualification',Path(__file__).with_name('ci-qualification.py'))
ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)


class CiTargetGuardTests(unittest.TestCase):
    def setUp(self):
        self.identifier='a'*64;self.network_id='b'*64
        self.container={'Id':self.identifier,'Config':{'Image':'postgres:16','Env':['POSTGRES_USER=migration','POSTGRES_PASSWORD=disposable-ci-only','POSTGRES_DB=veevee_django_migration']},
            'State':{'Running':True,'Health':{'Status':'healthy'}},'HostConfig':{'Privileged':False},
            'NetworkSettings':{'Networks':{'job':{'NetworkID':self.network_id,'IPAddress':'172.18.0.2'}},'Ports':{'5432/tcp':[{'HostIp':'0.0.0.0','HostPort':'32768'}]}},
            'Mounts':[{'Type':'tmpfs','Destination':'/var/lib/postgresql/data'}]}
        self.network={'Id':self.network_id,'Driver':'bridge','Containers':{self.identifier:{}}}

    def verify(self,container=None,network=None):
        return ci.validate_target(container or self.container,network or self.network,container_id=self.identifier,network_id=self.network_id,port=32768)

    def test_exact_service_identity_network_mount_and_port_are_required(self):
        self.assertEqual(self.verify(),'172.18.0.2')
        changes=[(['Id'],'c'*64),(['Config','Image'],'postgres:18'),(['State','Running'],False),
            (['State','Health','Status'],'starting'),(['HostConfig','Privileged'],True),
            (['NetworkSettings','Networks'],{'shared':{'NetworkID':'c'*64,'IPAddress':'10.0.0.1'}}),
            (['NetworkSettings','Ports'],{'5432/tcp':[{'HostIp':'0.0.0.0','HostPort':'5432'}]}),
            (['Mounts'],[{'Type':'bind','Destination':'/var/lib/postgresql/data','Source':'/production'}]),
            (['Config','Env'],['POSTGRES_USER=production'])]
        for path,value in changes:
            candidate=copy.deepcopy(self.container);target=candidate
            for key in path[:-1]: target=target[key]
            target[path[-1]]=value
            with self.subTest(path=path),self.assertRaises(RuntimeError):self.verify(candidate)
        network=copy.deepcopy(self.network);network['Containers']={}
        with self.assertRaises(RuntimeError):self.verify(network=network)

    def test_child_environment_discards_credentials_proxies_and_preload_hooks(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'DATABASE_URL':'private','GOOGLE_API_KEY':'private','NODE_OPTIONS':'--require private','PYTHONPATH':'private','HTTPS_PROXY':'private','AWS_PROFILE':'private'}):
            env=ci.safe_environment(Path(directory))
        for key in ('DATABASE_URL','GOOGLE_API_KEY','NODE_OPTIONS','PYTHONPATH','HTTPS_PROXY','AWS_PROFILE'):
            self.assertNotIn(key,env)
        self.assertEqual(env['HOME'],str(Path(directory)/'home'))
        self.assertEqual(env['ENV_FILE'],str(Path(directory)/'empty.env'))

    def test_source_copy_excludes_dotenv_uploads_and_unrelated_public_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'checkout';root.mkdir()
            session=Path(directory)/'session';session.mkdir()
            names=['package.json','backend/manage.py','backend/.env.example','.env.local',
                'src/view.js','public/logo.png','public/mag_key.png','public/media/upload.png',
                'public/media/.gitkeep','docs/fixture.md','credentials.json']
            for name in names:
                destination=root/name;destination.parent.mkdir(parents=True,exist_ok=True)
                destination.write_text('synthetic source')
            (root/'node_modules').mkdir()
            with patch.object(ci,'ROOT',root),patch.object(ci.subprocess,'check_output',return_value=('\0'.join(names)+'\0').encode()),patch.object(ci.subprocess,'run'):
                copied=ci.clean_copy(session,ci.safe_environment(session))
            self.assertEqual({path.relative_to(copied).as_posix() for path in copied.rglob('*') if path.is_file()},
                {'package.json','backend/manage.py','src/view.js','public/logo.png','public/media/.gitkeep','docs/fixture.md'})
            self.assertTrue((copied/'node_modules').is_symlink())


if __name__=='__main__': unittest.main()
