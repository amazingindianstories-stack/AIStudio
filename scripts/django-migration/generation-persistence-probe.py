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
    transaction.set_rollback(True)
assert not Generation.objects.filter(pk__in=identifiers).exists()
print(json.dumps({'generation_orm_kinds': cases, 'generation_columns': 60,
                  'fixture_rows_rolled_back': True, 'provider_calls': 0,
                  'history_count_full_schema_checks': 5,
                  'update_selection_checks': ['inflight', 'strict_watermark', 'exclude_audio', 'public_shape', 'descending_order', 'newest_100_cap', 'fractional_rejected', 'overflow_rejected'],
                  'scope': 'ORM persistence only; not enqueue API or provider/MOV-byte qualification'}))
