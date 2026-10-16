"""Deterministic history response goldens and live managed PostgreSQL plans."""
import json
from django.db import connection
from django.http import QueryDict
from django.test import TransactionTestCase
from apps.generation.models import Generation
from apps.generation.history import query_history
from apps.library.models import Folder
from apps.library.filenames import batch_resolve_generation_filenames


def case_folded_filenames(value):
    """Historical Node outputs lower-cased folder names in filenames; since
    2026-10-13 filenames keep the folder's case (owner decision). Compare
    everything else exactly and filenames without letter case."""
    if isinstance(value, dict):
        return {k: (v.lower() if k == 'filename' and isinstance(v, str) else case_folded_filenames(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [case_folded_filenames(v) for v in value]
    return value
from testsupport.frozen_oracle import run as oracle_run


class HistoricalHistoryPlanTests(TransactionTestCase):
    def setUp(self):
        self.root = Folder.objects.create(id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name='Root',
            name_normalized='root', version=1, created_at=1, updated_at=2)
        self.child = Folder.objects.create(id='cccccccc-cccc-4ccc-8ccc-cccccccccccc', name='Child',
            name_normalized='child', version=1, parent=self.root, created_at=3, updated_at=4)
        self.ids = [f'aaaaaaaa-aaaa-4aaa-8aaa-{index:012d}' for index in range(6)]
        rows = []
        for index, kind in enumerate(('image','video','depth','audio','image','image')):
            rows.append(Generation(id=self.ids[index], kind=kind, model='fixture-only', status='succeeded',
                prompt='100%_fixture\\ref' if index == 0 else 'Other fixture', aspect_ratio='16:9',
                folder=self.child if index == 4 else self.root if index == 0 else None,
                is_favorite=index in (0,2,3), created_at=1, updated_at=index+1))
        for index in range(5000):
            rows.append(Generation(id=f'10000000-0000-4000-8000-{index:012d}', kind='image', model='fixture-only',
                status='succeeded', prompt='history-plan-large-fixed', aspect_ratio='16:9', folder=self.root,
                created_at=index+10, updated_at=1))
        Generation.objects.bulk_create(rows)

    def test_frozen_response_contract_and_live_plans(self):
        cases=[{'filter':{'q':'100%_fixture\\ref'}}, {'filter':{'q':'history-plan-absent'}},
            {'filter':{'folderId':str(self.root.id)}},
            {'filter':{},'cursor':{'sort':1,'id':self.ids[4]}},
            {'filter':{'q':'history-plan-large-fixed'}},
            {'filter':{'q':'history-plan-large-fixed-absent'}},
            {'filter':{'folderId':str(self.root.id)}, 'cursor':{'sort':2500,'id':'ffffffff-ffff-4fff-8fff-ffffffffffff'}}]
        expected=json.loads(oracle_run(['node','--import','tsx','scripts/django-migration/history-plan-oracle.mjs'],
            input=json.dumps(cases),capture_output=True,text=True,check=True).stdout)
        with connection.cursor() as cursor:
            cursor.execute('ANALYZE generations')
        for entry, historical in zip(cases, expected):
            params=QueryDict(mutable=True)
            params.update(entry['filter'])
            if 'cursor' in entry:
                params['cursor']=str(entry['cursor']['sort'])+'.'+entry['cursor']['id']
            captured=[]
            def capture(execute, statement, bindings, many, context):
                if not captured:
                    captured.append((statement, bindings))
                return execute(statement, bindings, many, context)
            with connection.execute_wrapper(capture):
                page=query_history(params)
            self.assertEqual(case_folded_filenames(page), case_folded_filenames(historical['page']))
            statement, bindings=captured[0]
            self.assertTrue(statement.lstrip().upper().startswith('SELECT'))
            with connection.cursor() as cursor:
                cursor.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement, bindings)
                plan=cursor.fetchone()[0][0]
            self.assertIn('Plan', plan)
            self.assertGreaterEqual(plan['Execution Time'], 0)
        self.assertEqual(Generation.objects.count(), 5006)

    def test_batch_filename_frozen_contract_is_read_only(self):
        batches=[[], self.ids, [self.ids[0]], [self.ids[0],self.ids[0]], list(reversed(self.ids)),
            ['ffffffff-ffff-4fff-8fff-ffffffffffff']]
        expected=json.loads(oracle_run(['node','--import','tsx','scripts/django-migration/batch-filename-oracle.mjs'],
            input=json.dumps(batches),capture_output=True,text=True,check=True).stdout)
        before=list(Generation.objects.values_list('id','location_version','folder_id'))
        actual=[batch_resolve_generation_filenames(batch) for batch in batches]
        self.assertEqual(case_folded_filenames(actual), case_folded_filenames(expected))
        self.assertEqual(actual[2][str(self.ids[0])]['filename'].split('_')[0], self.root.name.strip().replace(' ', '_').split('_')[0])
        self.assertEqual(list(Generation.objects.values_list('id','location_version','folder_id')), before)
