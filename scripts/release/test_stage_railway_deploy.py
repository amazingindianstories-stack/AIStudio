"""Unit tests for stage_railway_deploy.py: stdlib only, a throwaway git repository, no network and no secrets.

    python3 -m unittest discover -s scripts/release -p 'test_*.py'
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stage_railway_deploy as stage  # noqa: E402

GIT = ['git', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false']


class DeploySettingsTests(unittest.TestCase):
    def test_api_and_mcp_share_the_gateway_health_check_and_overlap(self):
        expected = {'healthcheckPath': '/__g4_readiness', 'healthcheckTimeout': 120, 'overlapSeconds': 20, 'drainingSeconds': 30}
        for component in ('api', 'mcp'):
            settings = stage.deploy_settings(component)
            self.assertEqual(settings['startCommand'], f'python -m deploy.entrypoint {component}')
            self.assertEqual({key: settings[key] for key in expected}, expected)

    def test_agent_has_no_http_settings_and_never_overlaps(self):
        settings = stage.deploy_settings('agent')
        self.assertEqual(settings, {'startCommand': 'python -m deploy.entrypoint agent', 'restartPolicyType': 'ON_FAILURE',
                                    'restartPolicyMaxRetries': 10, 'overlapSeconds': 0})
        self.assertFalse({'healthcheckPath', 'healthcheckTimeout', 'port'} & set(settings))

    def test_existing_components_keep_their_settings(self):
        self.assertEqual(stage.deploy_settings('generation')['overlapSeconds'], 0)
        self.assertEqual(stage.deploy_settings('generation')['drainingSeconds'], 120)
        for component in ('export', 'scheduler'):
            self.assertEqual(set(stage.deploy_settings(component)), {'startCommand', 'restartPolicyType', 'restartPolicyMaxRetries'})

    def test_no_overlap_changes_only_the_overlap_of_api_and_mcp(self):
        for component in ('api', 'mcp'):
            default, staged = stage.deploy_settings(component), stage.deploy_settings(component, no_overlap=True)
            self.assertEqual(staged['overlapSeconds'], 0)
            self.assertEqual({**default, 'overlapSeconds': 0}, staged)
            self.assertEqual(default['overlapSeconds'], 20)

    def test_no_overlap_is_refused_for_other_components(self):
        for component in ('generation', 'export', 'scheduler', 'agent'):
            with self.assertRaises(SystemExit, msg=component):
                stage.deploy_settings(component, no_overlap=True)

    def test_unknown_component_is_refused(self):
        with self.assertRaises(SystemExit):
            stage.deploy_settings('web')


class StageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='stage-test-'))
        self.repo, self.gates = self.tmp / 'repo', self.tmp / 'gates'
        (self.repo / 'backend').mkdir(parents=True)
        self.gates.mkdir()
        (self.repo / 'backend' / 'app.py').write_text('print(1)\n')
        (self.repo / 'backend' / 'railway.toml').write_text('[deploy]\n')
        subprocess.run(['git', 'init', '-q'], cwd=self.repo, check=True)
        subprocess.run([*GIT, 'add', '.'], cwd=self.repo, check=True)
        subprocess.run([*GIT, 'commit', '-qm', 'one'], cwd=self.repo, check=True)
        self.commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def tearDown(self):
        subprocess.run(['rm', '-rf', str(self.tmp)], check=True)

    def stage(self, component, out='out', **kwargs):
        previous = Path.cwd()
        os.chdir(self.repo)
        try:
            with unittest.mock.patch.dict(os.environ, {'VEEVEE_GATE_DIR': str(self.gates)}), contextlib.redirect_stdout(io.StringIO()):
                stage.main(self.commit, component, str(self.tmp / out), **kwargs)
        finally:
            os.chdir(previous)
        return json.loads((self.tmp / out / 'railway.json').read_text())

    def pass_gates(self):
        (self.gates / f'{self.commit}.json').write_text('{}')
        (self.gates / f'{self.commit}.rehearsal.json').write_text('{}')

    def test_refuses_without_the_gate_and_rehearsal_records(self):
        with self.assertRaisesRegex(SystemExit, 'No release-gate pass'):
            self.stage('mcp')
        (self.gates / f'{self.commit}.json').write_text('{}')
        with self.assertRaisesRegex(SystemExit, 'No local rehearsal pass'):
            self.stage('mcp', out='out2')

    def test_stages_the_agent_worker_without_http_settings(self):
        self.pass_gates()
        config = self.stage('agent')
        self.assertEqual(config['deploy']['startCommand'], 'python -m deploy.entrypoint agent')
        self.assertNotIn('healthcheckPath', config['deploy'])
        self.assertEqual((config['deploy']['overlapSeconds'], config['deploy']['restartPolicyType']), (0, 'ON_FAILURE'))
        self.assertEqual(config['build'], {'builder': 'DOCKERFILE', 'dockerfilePath': 'backend/Dockerfile'})
        self.assertTrue((self.tmp / 'out' / 'backend' / 'app.py').exists())
        self.assertFalse((self.tmp / 'out' / 'backend' / 'railway.toml').exists())
        self.assertEqual((self.tmp / 'out' / 'STAGED_COMMIT').read_text().strip(), self.commit)

    def test_stages_mcp_and_the_no_overlap_variant(self):
        self.pass_gates()
        default = self.stage('mcp')
        self.assertEqual((default['deploy']['healthcheckPath'], default['deploy']['overlapSeconds']), ('/__g4_readiness', 20))
        pause = self.stage('mcp', out='out2', no_overlap=True)
        self.assertEqual((pause['deploy']['healthcheckPath'], pause['deploy']['overlapSeconds']), ('/__g4_readiness', 0))


if __name__ == '__main__':
    unittest.main()
