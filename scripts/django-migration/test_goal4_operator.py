import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('operator', Path(__file__).with_name('goal4-operator.py'))
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class Goal4OperatorGuardTests(unittest.TestCase):
    def test_default_noop_does_not_validate_or_execute_remote_work(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / 'plan.json'
            plan.write_text(json.dumps({'targets': {'api_service_id': 'UNKNOWN'}}))
            args = argparse.Namespace(plan=str(plan), execute=False)
            with patch.object(operator.subprocess, 'run', side_effect=AssertionError('remote invocation')), patch.object(operator, 'validate', side_effect=AssertionError('should not require credentials')):
                operator.run(args)

    def test_unknown_target_cannot_execute_even_with_confirmation(self):
        with self.assertRaisesRegex(ValueError, 'Operator input required'):
            operator.validate({'targets': {}, 'approval_scope': 'GOAL4_PRODUCTION_CUTOVER'})

    def test_explicit_confirmation_and_receipts_required(self):
        with tempfile.TemporaryDirectory() as directory:
            plan = Path(directory) / 'plan.json'
            plan.write_text('{}')
            args = argparse.Namespace(plan=str(plan), execute=True, confirm=None, step='migrate', receipts=None)
            with patch.object(operator.subprocess, 'run', side_effect=AssertionError('remote invocation')):
                with self.assertRaisesRegex(ValueError, 'Explicit execute'):
                    operator.run(args)

    def test_intent_precedes_side_effect_and_success_is_not_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'receipt.json'
            hook = {'path': '/reviewed/hook', 'sha256': 'fixture', 'timeout_seconds': 1}
            def execute(*args, **kwargs):
                self.assertEqual(json.loads(receipt.read_text())['steps']['inventory']['status'], 'ATTEMPTING')
                return SimpleNamespace(returncode=0, stdout=b'private diagnostics', stderr=b'')
            with patch.object(operator.subprocess, 'run', side_effect=execute) as invoked:
                operator.execute_step({'hooks': {'inventory': hook}}, Path('/reviewed/plan'), 'plan-hash', receipt, 'inventory')
                self.assertEqual(invoked.call_count, 1)
                self.assertEqual(json.loads(receipt.read_text())['steps']['inventory']['status'], 'AWAITING_OPERATOR_VERIFICATION')
                with self.assertRaisesRegex(ValueError, 'already attempted'):
                    operator.execute_step({'hooks': {'inventory': hook}}, Path('/reviewed/plan'), 'plan-hash', receipt, 'inventory')

    def test_unverified_previous_step_and_changed_plan_cannot_advance(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'receipt.json'
            receipt.write_text(json.dumps({'plan_sha256': 'plan-hash', 'steps': {'inventory': {'status': 'AWAITING_OPERATOR_VERIFICATION'}}}))
            with patch.object(operator.subprocess, 'run', side_effect=AssertionError('side effect')):
                with self.assertRaisesRegex(ValueError, 'not operator-verified'):
                    operator.execute_step({}, Path('/plan'), 'plan-hash', receipt, 'backup')
                with self.assertRaisesRegex(ValueError, 'Plan changed'):
                    operator.execute_step({}, Path('/plan'), 'changed', receipt, 'backup')

    def test_timeout_is_ambiguous_and_must_not_be_replayed(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'receipt.json'
            plan = {'hooks': {'inventory': {'path': '/hook', 'sha256': 'fixture', 'timeout_seconds': 1}}}
            with patch.object(operator.subprocess, 'run', side_effect=operator.subprocess.TimeoutExpired('/hook', 1)):
                with self.assertRaises(SystemExit):
                    operator.execute_step(plan, Path('/plan'), 'hash', receipt, 'inventory')
            self.assertEqual(json.loads(receipt.read_text())['steps']['inventory']['status'], 'AMBIGUOUS_TIMEOUT_DO_NOT_REPEAT')

    def test_shipped_command_templates_cover_every_step_without_secret_flags_or_rebuilds(self):
        spec = importlib.util.spec_from_file_location('templates', Path(__file__).with_name('goal4-command-plan.py'))
        templates = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(templates)
        matrix = templates.commands({})
        self.assertEqual(set(matrix), set(operator.STEPS + operator.ROLLBACK))
        for details in matrix.values():
            for argv in details['argv']:
                self.assertNotIn('--token', argv)
                self.assertNotIn('up', argv)
                self.assertNotIn('redeploy', argv)
                self.assertNotIn('--fake-initial', argv)
        self.assertIn('--deployment-instance', matrix['migrate']['argv'][0])
        self.assertEqual(matrix['fence']['argv'][0][-2:], ['<VERIFIED_RAILWAY_REGION>=0', '--json'])
