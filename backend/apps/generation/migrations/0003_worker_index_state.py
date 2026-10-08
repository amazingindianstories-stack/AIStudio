from django.db import migrations, models
from django.db.models.expressions import RawSQL
from apps.common.indexes import PostgreSQLIndex


class Migration(migrations.Migration):
    dependencies = [('generation','0002_declared_indexes')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[],state_operations=[
        migrations.AddIndex('generation',PostgreSQLIndex(name='generations_stale_video_poll_idx',fields=['updated_at','created_at','id'],
            condition=models.Q(RawSQL("kind = 'video' and status in ('queued', 'running') and task_id is not null", [], output_field=models.BooleanField())))),
        migrations.AddIndex('generation',PostgreSQLIndex(name='generations_coordinator_due_idx',fields=['status','next_poll_at','created_at'],
            condition=models.Q(RawSQL("(kind = 'video' and status in ('queued', 'running')) or (kind = 'image' and (status = 'queued' or (status = 'running' and model like 'Magnific %%')))", [], output_field=models.BooleanField())))),
    ])]
