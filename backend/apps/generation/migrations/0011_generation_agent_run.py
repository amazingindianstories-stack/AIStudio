"""Additive Agents tab provenance: generations.agent_run_id, nullable, no default and no backfill. Its index is built
concurrently in 0012."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0010_generation_output')]
    operations = [
        migrations.AddField(model_name='generation', name='agent_run_id', field=models.UUIDField(null=True)),
    ]
