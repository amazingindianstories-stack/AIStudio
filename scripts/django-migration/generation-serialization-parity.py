"""Compare actual Node rowToItem with Django without DB/provider execution."""
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from uuid import UUID

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1':
    raise SystemExit('Isolated runner required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
from apps.generation.serialization import REQUIRED, OPTIONAL, camel, generation_item

fields = set(REQUIRED + OPTIONAL + ('source_generation_id', 'draft_task_id', 'poll_attempts',
                                  'poll_error_count', 'location_version', 'cost_basis', 'provider_responses'))
base = dict.fromkeys(fields)
base.update(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind='video',status='queued',prompt='दृश्य',
            model='fixture-only',aspect_ratio='16:9',depth_reap_attempts=0,is_favorite=False,
            flagged=False,created_at=1,updated_at=2,provider_responses={'private':'must-not-leak'})
rows = [base, dict(base, generate_audio=False,draft_mode=False,duration=0,seed=0,cost_cents=0,
    reference_images=[],reference_videos=[],moderation_blocked=False,continuation_frame_url='/fixture/frame.png'),
    dict(base,cost_basis='reconciled',source_generation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
         draft_task_id='fixture-draft',judge_score={'identity':0.5},reference_audios=[{'url':'/fixture/audio.wav'}])]
# Build an independent full-column case from model metadata, rather than the
# serializer's own lists: omissions in those lists must fail against Node.
import django
django.setup()
from apps.generation.models import Generation
full = {}
for field in Generation._meta.concrete_fields:
    name = field.attname
    kind = field.get_internal_type()
    if kind in ('UUIDField', 'ForeignKey', 'OneToOneField'):
        item = UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    elif kind == 'BooleanField':
        item = True
    elif kind in ('IntegerField', 'BigIntegerField'):
        item = 123
    elif kind == 'JSONField':
        item = {'fixture': name}
    else:
        item = 'fixture-' + name
    full[name] = item
full['cost_basis'] = 'reconciled'
rows.append(full)
wire = [{camel(key): str(item) if isinstance(item, UUID) else item for key, item in row.items()} for row in rows]
result = subprocess.run(['node','--import','tsx','scripts/django-migration/generation-serialization-oracle.mjs'],
    input=json.dumps(wire),text=True,capture_output=True,check=True)
node = json.loads(result.stdout)
python = [generation_item(SimpleNamespace(**row)) for row in rows]
assert node == python, (node,python)
assert all('providerResponses' not in row for row in python)
print(json.dumps({'independent_model_columns':len(full),'public_generation_shape_cases':len(rows),'node_django_equal':True,'provider_diagnostics_excluded':True,'database_calls':0,'provider_calls':0}))
