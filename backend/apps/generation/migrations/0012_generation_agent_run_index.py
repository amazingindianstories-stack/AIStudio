"""A partial index on generations.agent_run_id for the jobs an Agents tab run is waiting on, built without locking
writes. Web and MCP rows leave the column NULL, so they are not in the index."""
from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models

from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    atomic = False
    dependencies = [('generation', '0011_generation_agent_run')]
    operations = [
        AddIndexConcurrently(model_name='generation', index=PostgreSQLIndex(
            fields=['agent_run_id'], condition=models.Q(agent_run_id__isnull=False), name='generations_agent_run_idx')),
    ]
