"""Additive provenance; historical uploaders deliberately remain unknown."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('assets', '0003_baseline_portraitasset')]
    operations = [
        migrations.AddField(model_name='asset', name='created_by_id', field=models.UUIDField(null=True)),
        migrations.AddField(model_name='portraitasset', name='created_by_id', field=models.UUIDField(null=True)),
    ]
