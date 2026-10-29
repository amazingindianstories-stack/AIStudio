"""An equality index on generations.url for agent reference and upscale-source lookups, built without locking writes.

A hash index, because output URLs have no length bound and a btree entry must fit in a page."""
from django.contrib.postgres.indexes import HashIndex
from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations


class Migration(migrations.Migration):
    atomic = False
    dependencies = [('generation', '0008_generation_mcp_origin')]
    operations = [
        AddIndexConcurrently(model_name='generation', index=HashIndex(fields=['url'], name='generations_url_hash_idx')),
    ]
