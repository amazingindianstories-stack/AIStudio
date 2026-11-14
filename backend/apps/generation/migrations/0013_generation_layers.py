"""Additive layer-decomposition result: one nullable column with no default and no backfill."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0012_generation_agent_run_index')]
    operations = [
        migrations.AddField(model_name='generation', name='layers', field=models.JSONField(null=True)),
    ]
