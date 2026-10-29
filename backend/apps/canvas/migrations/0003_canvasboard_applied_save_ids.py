"""Ids of the latest saves a board applied, so a draft left behind by a save that landed is not replayed."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0002_canvasboard_version')]
    operations = [
        migrations.AddField(model_name='canvasboard', name='applied_save_ids', field=models.JSONField(db_default=[])),
    ]
