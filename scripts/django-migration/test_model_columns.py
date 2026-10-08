"""Negative controls: a green column guard must reject meaningful schema drift."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('model_columns', Path(__file__).with_name('model-columns.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ModelColumnGuardTests(unittest.TestCase):
    def setUp(self):
        self.expected = {'media_export_items': {'columns': {
            'export_id': {'type': 'uuid', 'nullable': False},
            'generation_id': {'type': 'uuid', 'nullable': False},
            'position': {'type': 'integer', 'nullable': False},
        }, 'primary_key': ['export_id', 'generation_id']}}

    def test_matching_inventory(self):
        self.assertEqual(module.compare(self.expected, deepcopy(self.expected)), [])

    def test_missing_and_extra_tables_fail(self):
        self.assertTrue(module.compare(self.expected, {}))
        self.assertTrue(module.compare({}, self.expected))

    def test_missing_column_and_bigint_downgrade_fail(self):
        actual = deepcopy(self.expected)
        del actual['media_export_items']['columns']['position']
        self.assertTrue(module.compare(self.expected, actual))
        actual = deepcopy(self.expected)
        actual['media_export_items']['columns']['position']['type'] = 'bigint'
        self.assertTrue(module.compare(self.expected, actual))

    def test_nullability_and_composite_key_drift_fail(self):
        actual = deepcopy(self.expected)
        actual['media_export_items']['columns']['generation_id']['nullable'] = True
        self.assertTrue(module.compare(self.expected, actual))
        actual = deepcopy(self.expected)
        actual['media_export_items']['primary_key'] = ['export_id']
        self.assertTrue(module.compare(self.expected, actual))

    def test_foreign_key_deletion_policy_and_target_fail(self):
        expected = deepcopy(self.expected)
        expected['media_export_items']['foreign_keys'] = [{'columns': ['export_id'],
            'target_table': 'media_exports', 'target_columns': ['id'], 'on_delete': 'cascade'}]
        self.assertTrue(module.compare(expected, self.expected))
        actual = deepcopy(expected)
        actual['media_export_items']['foreign_keys'][0]['on_delete'] = 'restrict'
        self.assertTrue(module.compare(expected, actual))
        actual = deepcopy(expected)
        actual['media_export_items']['foreign_keys'][0]['target_table'] = 'generations'
        self.assertTrue(module.compare(expected, actual))

    def test_column_uniqueness_drift_fails(self):
        expected = deepcopy(self.expected)
        expected['media_export_items']['columns']['export_id']['unique'] = False
        actual = deepcopy(expected)
        actual['media_export_items']['columns']['export_id']['unique'] = True
        self.assertTrue(module.compare(expected, actual))
