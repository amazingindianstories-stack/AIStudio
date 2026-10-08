"""Full-width ORM roundtrips against the harness's disposable PG16 schema only."""
import json
import os
from urllib.parse import urlsplit
from uuid import uuid4

url = urlsplit(os.environ.get('DATABASE_URL', ''))
if (os.environ.get('VEEVEE_GENERATION_PERSISTENCE_TEST') != '1'
        or not (url.hostname or '').startswith('veevee-qualification-pg-')
        or url.path != '/veevee_django_migration'):
    raise SystemExit('Verified disposable container target required')

os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings.production'
import django
django.setup()
from django.db import transaction
from apps.generation.models import Generation

assert len(Generation._meta.concrete_fields) == 60
identifiers = []
cases = []
with transaction.atomic():
    for kind in ['image', 'video', 'depth']:
        identifier = uuid4()
        identifiers.append(identifier)
        values = {'id': identifier, 'kind': kind, 'status': 'queued', 'prompt': 'दृश्य fixture',
                  'model': 'fixture-only', 'aspect_ratio': '16:9', 'created_at': 9007199254740993,
                  'updated_at': 9007199254740995, 'reference_images': [{'url': '/fixture/reference.png'}],
                  'provider_responses': {'fixture': True}, 'seed': 2147483647}
        if kind == 'video':
            values.update(generate_audio=False, draft_mode=False, bitrate_mode='high', video_task_mode='edit',
                          reference_videos=[{'url': '/fixture/source.mov'}], reference_audios=[],
                          source_generation_id=uuid4(), draft_task_id='fixture-draft',
                          url='/fixture/native-master.mov', candidate_task_ids=['fixture-task'])
        if kind == 'depth':
            values.update(depth_claim_id=uuid4(), depth_claim_worker_id='fixture-gpu',
                          track_characters=True, progress_percent=37, progress_message='fixture progress')
        Generation.objects.create(**values)
        row = Generation.objects.get(pk=identifier)
        for name, expected in values.items():
            assert getattr(row, name) == expected, (kind, name)
        assert row.project_id is None and row.folder_id is None
        assert (row.cost_cents, row.cost_basis, row.location_version) == (0, 'estimated', 1)
        assert (row.poll_attempts, row.poll_error_count, row.depth_reap_attempts) == (0, 0, 0)
        assert row.worker_lease_id is None and row.worker_lease_until is None
        if kind != 'video':
            assert row.generate_audio is None and row.draft_mode is None and row.video_task_mode is None
        if kind != 'depth':
            assert row.depth_claim_id is None and row.progress_percent is None
        cases.append(kind)
    from apps.generation.history_counts import base_query, grouped
    # Remove preexisting invariant fixtures from this probe's query using a
    # unique prompt marker, while retaining the real complete physical schema.
    marker = 'count-probe-' + uuid4().hex
    for kind, favorite in [('image', True), ('video', False), ('depth', True), ('audio', True)]:
        identifier = uuid4()
        identifiers.append(identifier)
        Generation.objects.create(id=identifier, kind=kind, status='queued',
            prompt=marker+' 100%_literal\\ref', model='fixture-only', aspect_ratio='16:9',
            is_favorite=favorite, created_at=1, updated_at=2)
    rows = base_query(None, marker)
    assert grouped(rows) == {'total': 3, 'unsorted': 3, 'byFolder': {}}
    assert rows.filter(is_favorite=True).count() == 2
    assert base_query('audio', marker).count() == 1
    assert base_query('image', marker+' 100%_literal\\ref').count() == 1
    assert base_query(None, marker+' 100XXliteralXref').count() == 0
    from apps.generation.updates import read_generation_updates
    # Use a future watermark to exclude invariant fixtures and retain old
    # in-flight rows; assert the exact strict > boundary for completed rows.
    watermark = 9007199254741000
    boundary_ids = {}
    for label, kind, status, updated in [
        ('queued', 'image', 'queued', 1), ('running', 'depth', 'running', 2),
        ('equal', 'video', 'completed', watermark),
        ('new', 'video', 'completed', watermark+1),
        ('audio', 'audio', 'running', watermark+2)]:
        identifier = uuid4()
        identifiers.append(identifier)
        boundary_ids[label] = str(identifier)
        Generation.objects.create(id=identifier, kind=kind, status=status,
            prompt='update fixture', model='fixture-only', aspect_ratio='16:9',
            created_at=1, updated_at=updated, provider_responses={'private': 'excluded'})
    updates = read_generation_updates(watermark)
    selected = {row['id'] for row in updates}
    assert {boundary_ids['queued'], boundary_ids['running'], boundary_ids['new']} <= selected
    assert boundary_ids['equal'] not in selected and boundary_ids['audio'] not in selected
    assert all('providerResponses' not in row for row in updates)
    assert [row['updatedAt'] for row in updates] == sorted([row['updatedAt'] for row in updates], reverse=True)
    for invalid, expected_code in [(1.5, '22P02'), (1e20, '22003')]:
        from django.db import DatabaseError
        try:
            with transaction.atomic():
                read_generation_updates(invalid)
        except DatabaseError as error:
            assert getattr(error.__cause__, 'sqlstate', None) == expected_code
        else:
            raise AssertionError('Invalid update operand was silently accepted')
    cap_ids = []
    for index in range(105):
        identifier = uuid4()
        identifiers.append(identifier)
        cap_ids.append(str(identifier))
        Generation.objects.create(id=identifier, kind='image', status='completed',
            prompt='cap fixture', model='fixture-only', aspect_ratio='16:9',
            created_at=1, updated_at=watermark+100+index)
    updates = read_generation_updates(watermark)
    assert len(updates) == 100
    assert [row['id'] for row in updates] == list(reversed(cap_ids[5:]))
    from django.http import QueryDict
    from apps.generation.history import query_history
    from apps.library.models import GenerationNaming
    history_marker = 'history-probe-' + uuid4().hex
    history_ids = []
    for index in range(5):
        identifier = uuid4()
        identifiers.append(identifier)
        history_ids.append(str(identifier))
        Generation.objects.create(id=identifier, kind='audio' if index==4 else 'image',
            status='completed', prompt=history_marker, model='fixture-only', aspect_ratio='16:9',
            created_at=10, updated_at=10, is_favorite=index in (0,2),
            favorited_at=42+index if index in (0,2) else None)
        GenerationNaming.objects.create(generation_id=identifier,namespace='global_unsorted',sequence=400000+index,assigned_at=10)
    def history_page(**values):
        params = QueryDict(mutable=True)
        params.update({'q':history_marker, **values})
        return query_history(params)
    first_page = history_page(limit='2')
    original_order = sorted(history_ids[:4], reverse=True)
    assert [item['id'] for item in first_page['items']] == original_order[:2]
    assert first_page['nextCursor'] == '10.'+original_order[1]
    newer = uuid4()
    identifiers.append(newer)
    Generation.objects.create(id=newer, kind='image', status='completed',
        prompt=history_marker, model='fixture-only', aspect_ratio='16:9', created_at=11, updated_at=11)
    last_page = history_page(limit='2', cursor=first_page['nextCursor'])
    assert [item['id'] for item in last_page['items']] == original_order[2:]
    assert last_page['nextCursor'] is None
    for item in first_page['items']+last_page['items']:
        naming = GenerationNaming.objects.get(pk=item['id'])
        assert item['filename'] == f'unsorted_{naming.sequence:04d}.png'
        assert 'providerResponses' not in item
    favorites = history_page(favorite='1',limit='1')
    assert favorites['items'][0]['id'] == history_ids[2]
    assert favorites['nextCursor'] == '44.'+history_ids[2]
    last_favorite = history_page(favorite='1',limit='1',cursor=favorites['nextCursor'])
    assert last_favorite['items'][0]['id'] == history_ids[0] and last_favorite['nextCursor'] is None
    audio_page = history_page(kind='audio')
    assert [item['id'] for item in audio_page['items']] == [history_ids[4]]
    from apps.library.models import Folder
    from django.db import connection
    from time import perf_counter
    performance_marker = 'history-query-count-' + uuid4().hex
    parent = None
    for depth in range(3):
        folder_id = uuid4()
        Folder.objects.create(id=folder_id,parent_id=parent,name=f'R{depth+1}',
            name_normalized=f'r{depth+1}',version=1,created_at=1,updated_at=1)
        parent = folder_id
    for index in range(100):
        identifier = uuid4()
        identifiers.append(identifier)
        Generation.objects.create(id=identifier,kind='image',status='completed',
            prompt=performance_marker,model='fixture-only',aspect_ratio='16:9',
            created_at=index+1,updated_at=index+1,folder_id=parent)
        GenerationNaming.objects.create(generation_id=identifier,namespace=f'folder:{parent}',sequence=500000+index,assigned_at=1)
    query_measurements = []
    for size in (1,20,100):
        count = [0]
        def count_queries(execute, statement, params, many, context):
            count[0] += 1
            assert statement.lstrip().upper().startswith('SELECT'), 'History read attempted mutation'
            return execute(statement,params,many,context)
        params = QueryDict(mutable=True)
        params.update({'q':performance_marker,'limit':str(size)})
        started = perf_counter()
        with connection.execute_wrapper(count_queries):
            page = query_history(params)
        elapsed = (perf_counter()-started)*1000
        assert len(page['items']) == size
        assert count[0] == 5, ('Per-item history queries',size,count[0])
        assert all(item['filename'].startswith('R1_R2_R3_') for item in page['items'])
        query_measurements.append({'page_size':size,'folder_depth':3,'queries':count[0],'elapsed_ms':round(elapsed,3)})
    large_rows = []
    for index in range(5000):
        identifier = uuid4()
        identifiers.append(identifier)
        large_rows.append(Generation(id=identifier,kind='image',status='completed',
            prompt=performance_marker,model='fixture-only',aspect_ratio='16:9',
            created_at=index+101,updated_at=index+101,folder_id=parent))
    Generation.objects.bulk_create(large_rows,batch_size=250)
    with connection.cursor() as cursor:
        cursor.execute('ANALYZE generations')
    plan_measurements = []
    def plan_nodes(node):
        result = [{'type':node['Node Type'],'rows':node.get('Actual Rows'),
            'removed':node.get('Rows Removed by Filter',0),'index':node.get('Index Name'),
            'index_condition':bool(node.get('Index Cond')),'sort':node.get('Sort Method')}]
        for child in node.get('Plans',[]):
            result.extend(plan_nodes(child))
        return result
    for label,values in [('search',{'q':performance_marker}),
            ('search_miss',{'q':performance_marker+'-absent'}),
            ('folder',{'folderId':str(parent)}),
            ('folder_cursor',{'folderId':str(parent),'cursor':'2500.ffffffff-ffff-4fff-8fff-ffffffffffff'})]:
        captured = []
        def capture_first(execute,statement,params,many,context):
            if not captured:
                captured.append((statement,params))
            return execute(statement,params,many,context)
        params = QueryDict(mutable=True)
        params.update({'limit':'20',**values})
        with connection.execute_wrapper(capture_first):
            page = query_history(params)
        assert len(page['items']) == (0 if label=='search_miss' else 20)
        statement,bindings = captured[0]
        assert statement.lstrip().upper().startswith('SELECT')
        with connection.cursor() as cursor:
            cursor.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement,bindings)
            plan = cursor.fetchone()[0][0]
        plan_measurements.append({'case':label,'fixture_rows':5100,
            'execution_ms':plan['Execution Time'],'nodes':plan_nodes(plan['Plan'])})
    transaction.set_rollback(True)
assert not Generation.objects.filter(pk__in=identifiers).exists()
print(json.dumps({'generation_orm_kinds': cases, 'generation_columns': 60,
                  'fixture_rows_rolled_back': True, 'provider_calls': 0,
                  'history_count_full_schema_checks': 5,
                  'history_query_measurements':query_measurements,
                  'history_plan_measurements':plan_measurements,
                  'history_full_schema_checks':['uuid_tie_order','composite_cursor','newer_insert_excluded','exact_multiple_terminal','persisted_names','favorite_keysets','audio_filter','private_diagnostics_omitted'],
                  'update_selection_checks': ['inflight', 'strict_watermark', 'exclude_audio', 'public_shape', 'descending_order', 'newest_100_cap', 'fractional_rejected', 'overflow_rejected'],
                  'scope': 'ORM persistence and history/count/update services; not enqueue API or provider/MOV-byte qualification'}))
