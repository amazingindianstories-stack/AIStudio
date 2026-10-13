"""Disposable-only additive upgrade after independently verified baseline."""
import os,json,sys
from urllib.parse import urlsplit
url=urlsplit(os.environ.get('DATABASE_URL',''))
if os.environ.get('VEEVEE_BASELINE_TEST')!='1' or not (url.hostname or '').startswith('veevee-qualification-pg-') or url.path not in ('/veevee_django_migration','/veevee_django_baseline'):
    raise SystemExit('Verified disposable additive target required')
payload=json.load(sys.stdin)
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.production'
import django
django.setup()
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder

def snapshot():
    with connection.cursor() as cursor:
        cursor.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name!='django_migrations' ORDER BY table_name")
        tables=[r[0] for r in cursor.fetchall()]
        result={}
        for table in tables:
            cursor.execute('SELECT to_jsonb(t) FROM '+connection.ops.quote_name(table)+' t')
            rows=[json.loads(r[0]) if isinstance(r[0],str) else r[0] for r in cursor.fetchall()]
            for row in rows:
                if table=='generations':row.pop('submission_input',None)
                if table in {'assets', 'portrait_assets'}:row.pop('created_by_id',None)
            result[table]=sorted(rows,key=lambda r:json.dumps(r,sort_keys=True))
        return result
def catalog():
    result={}
    with connection.cursor() as cursor:
        for category,query in payload['queries'].items():
            cursor.execute(query)
            result[category]=[dict(zip([c.name for c in cursor.description],row)) for row in cursor.fetchall()]
    return result
before_catalog=catalog()
before=snapshot()
assert len(before) == 21
with transaction.atomic():
    with connection.cursor() as cursor:
        cursor.execute("ALTER TABLE generations ADD COLUMN submission_input jsonb NULL;\nALTER TABLE assets ADD COLUMN created_by_id uuid NULL;\nALTER TABLE portrait_assets ADD COLUMN created_by_id uuid NULL;\nCREATE TABLE upload_sessions (\nid uuid NOT NULL PRIMARY KEY, actor_id uuid NOT NULL, key text NOT NULL UNIQUE,\npurpose varchar(64) NOT NULL, content_type varchar(100) NOT NULL, byte_size bigint NOT NULL,\nfilename varchar(255) NOT NULL, sha256 varchar(64) NOT NULL, request_key varchar(128) NOT NULL,\nsession_uri text NOT NULL, state varchar(16) NOT NULL, created_at timestamptz NOT NULL,\nexpires_at timestamptz NOT NULL, finalized_at timestamptz NULL,\nCONSTRAINT upload_positive_bytes CHECK (byte_size > 0));\nCREATE INDEX upload_sessions_key_8b9e8a1c_like ON upload_sessions (key text_pattern_ops);\nCREATE INDEX upload_actor_state_expiry_idx ON upload_sessions (actor_id, state, expires_at);\nCREATE UNIQUE INDEX upload_actor_request_unique ON upload_sessions (actor_id, request_key) WHERE NOT (request_key = '');")
    expected_catalog = catalog()
    transaction.set_rollback(True)
executor=MigrationExecutor(connection);targets=executor.loader.graph.leaf_nodes()
plan=executor.migration_plan(targets)
assert {(m.app_label,m.name,backward) for m,backward in plan} == {
    ('generation','0002_generation_submission_input',False),
    ('assets','0004_uploader_provenance',False), ('media','0001_uploadsession',False)}
assert len(plan) == 3
executor.migrate(targets);connection.close()
after_rows = snapshot()
assert after_rows.pop('upload_sessions') == [], 'New upload table must initially be empty'
assert after_rows == before, 'Historical application rows changed'
assert catalog() == expected_catalog, 'Catalog differs from exact reviewed additive SQL contract'
with connection.cursor() as cursor:
    for table, column in [('generations', 'submission_input'), ('assets', 'created_by_id'), ('portrait_assets', 'created_by_id')]:
        cursor.execute('SELECT count(*) FROM '+connection.ops.quote_name(table)+' WHERE '+connection.ops.quote_name(column)+' IS NOT NULL')
        assert cursor.fetchone()[0] == 0, 'Historical provenance or submission data was invented'
assert not MigrationExecutor(connection).migration_plan(targets)
assert len(MigrationRecorder(connection).applied_migrations())>=25
# Manifest v3 freezes a complete archive-relative path in the existing TEXT
# column. Verify storage and the composite key on real PG16, without DDL or
# changing historical rows. This does not replace the service path validator.
from uuid import uuid4
from apps.exports.models import MediaExport, MediaExportItem
v3_paths = ['Projects/Project_A/Scene_01/Shot_02/shot_02_0007.mov',
            'Projects/दृश्य/Unsorted/unsorted_0004.png',
            'Global/Folder_X/folder_x_0003.webp']
with transaction.atomic():
    job = MediaExport.objects.create(id=uuid4(), user_id=uuid4(), manifest_version=3,
                                    created_at=1, updated_at=1)
    for position, filename in enumerate(v3_paths):
        MediaExportItem.objects.create(export=job, generation_id=uuid4(),
            position=position, source_key='synthetic/master.mov', filename=filename)
    assert list(job.mediaexportitem_set.order_by('position').values_list('filename', flat=True)) == v3_paths
    with connection.cursor() as cursor:
        cursor.execute("SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='media_export_items' AND column_name='filename'")
        assert cursor.fetchone() == ('text',)
    assert catalog() == expected_catalog, 'Manifest v3 unexpectedly changed the catalog'
    transaction.set_rollback(True)
assert snapshot() == after_rows | {'upload_sessions': []}, 'v3 probe changed application rows'
print(json.dumps({'application_rows_preserved':True,'exact_additive_catalog_verified':True,'migrations':['generation.0002_generation_submission_input','assets.0004_uploader_provenance','media.0001_uploadsession'],'reopened_noop':True,'manifest_v3_text_roundtrip':True,'manifest_v3_schema_changes':0}))
