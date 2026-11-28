"""Additive missing-media marker: one nullable column with no default and no backfill (expand-safe for running code)."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0013_generation_layers')]
    operations = [
        migrations.AddField(model_name='generation', name='media_missing_at', field=models.BigIntegerField(null=True)),
    ]
