"""Optimistic concurrency for board saves: a constant default is a metadata-only column add, no rewrite."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0002_board_roles')]
    operations = [
        migrations.AddField(model_name='canvasboard', name='version', field=models.BigIntegerField(db_default=1)),
    ]
