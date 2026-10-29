"""Additive text-job output: one nullable column with no default and no backfill."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0009_generation_url_lookup')]
    operations = [
        migrations.AddField(model_name='generation', name='output', field=models.JSONField(null=True)),
    ]
