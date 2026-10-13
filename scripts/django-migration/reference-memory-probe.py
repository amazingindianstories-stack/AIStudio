"""Offline Python allocation comparison; excludes native image decoding."""
import gc
import json
import os
import platform
from pathlib import Path
import sys
import tracemalloc
from unittest.mock import patch

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified isolation runner required')
sys.path.insert(0,str(Path('backend').resolve()))
from django.test import override_settings
from apps.media.storage import StorageService, MemoryAdapter
from apps.generation.services.seedream_references import prepare_seedream_references

payload = b'x' * (24 * 1024 * 1024)
store = StorageService(MemoryAdapter())
ref = store.upload_buffer(payload,'assets/allocation-fixture.png','png')

def normalize(data):
    assert data == payload
    return {'bytes':data,'ext':'png','changed':False}

def measure(reader):
    gc.collect()
    tracemalloc.start()
    try:
        result = prepare_seedream_references([ref]*3,'fixture',sign=False,read=reader)
        assert result == {'stable':[ref]*3,'urls':[]}
        return tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

with override_settings(VEEVEE_MEDIA_STORAGE=store), patch(
        'apps.generation.services.seedream_references.normalize_seedream_reference',normalize):
    legacy = measure(store.read_as_base64)
    current = measure(None)
assert current < legacy * .8,(current,legacy)
print(json.dumps({'result':'PASS','python_version':platform.python_version(),
    'architecture':platform.machine(),'platform':platform.system(),
    'payload_bytes':len(payload),'references':3,
    'legacy_base64_reader_python_peak_bytes':legacy,'byte_reader_python_peak_bytes':current,
    'peak_ratio':current/legacy,'scope':'Actual memory storage/read/base64 pipeline; normalization injected; no native decoder/RSS or provider claim',
    'original_bytes_and_reference_urls_preserved':True,'network':'none'}))
