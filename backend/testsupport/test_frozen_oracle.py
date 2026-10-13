import json
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import SimpleTestCase
from . import frozen_oracle as oracle


class FrozenOracleIntegrityTests(SimpleTestCase):
    command=['node','scripts/django-migration/declared-columns.mjs']

    def test_all_fixture_inputs_outputs_and_provenance_verify(self):
        for path in oracle.DIRECTORY.glob('*.json'):
            fixture=json.loads(path.read_text())
            if 'request' in fixture:
                request=fixture['request']
                self.assertEqual(oracle.identity(request['command'],request['input'])[0],path.stem)
                self.assertEqual(oracle.run(request['command'],input=request['input'],text=True).stdout,fixture['stdout'])
        self.assertIn('CREATE TABLE',oracle.schema_sql())

    def test_unknown_input_rejected_without_a_process(self):
        with patch('subprocess.run',side_effect=AssertionError('No processes may be started')):
            with self.assertRaisesMessage(AssertionError,'No frozen historical oracle'):
                oracle.run(self.command,input='unknown')
            self.assertIn('generations',oracle.run(self.command,text=True).stdout)

    def test_corrupted_output_or_source_provenance_rejected(self):
        digest,_=oracle.identity(self.command)
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)
            shutil.copy(oracle.DIRECTORY/'provenance.json',target)
            fixture=json.loads((oracle.DIRECTORY/(digest+'.json')).read_text())
            path=target/(digest+'.json')
            original=fixture['stdout']
            fixture['stdout']='tampered'
            path.write_text(json.dumps(fixture))
            with patch.object(oracle,'DIRECTORY',target):
                with self.assertRaisesMessage(AssertionError,'output hash mismatch'):
                    oracle.run(self.command)
                fixture['stdout']=original
                fixture['source_revision']='0'*40
                path.write_text(json.dumps(fixture))
                with self.assertRaisesMessage(AssertionError,'source revision mismatch'):
                    oracle.run(self.command)
