"""Which objects each graph save changed, so open boards fetch only those (apps.canvas.patch): a nullable
column (existing rows read as "unknown") and an index for the per-board version range read, built without
locking the saves every graph change writes."""
from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    atomic = False
    dependencies = [('canvas', '0006_boardaijob')]
    operations = [
        migrations.AddField(model_name='canvasboardsave', name='changes', field=models.JSONField(null=True)),
        AddIndexConcurrently(model_name='canvasboardsave',
                             index=models.Index(fields=['board_id', 'version'], name='canvas_board_saves_version_idx')),
    ]
