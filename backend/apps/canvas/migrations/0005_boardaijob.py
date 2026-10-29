"""Additive board AI jobs: a new table that references canvas_boards (cascade) and nothing else."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0004_canvasboardsave')]
    operations = [
        migrations.CreateModel(
            name='BoardAiJob',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('user_id', models.UUIDField()),
                ('format', models.TextField()),
                ('prompt', models.TextField()),
                ('generation_id', models.UUIDField(unique=True)),
                ('placed_node_ids', models.JSONField(null=True)),
                ('placed_at', models.BigIntegerField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
                ('board', models.ForeignKey(db_column='board_id', db_index=False, on_delete=django.db.models.deletion.CASCADE, to='canvas.canvasboard')),
                ('parent_job', models.ForeignKey(db_column='parent_job_id', db_index=False, null=True, on_delete=django.db.models.deletion.SET_NULL, to='canvas.boardaijob')),
            ],
            options={
                'db_table': 'canvas_board_ai_jobs',
                'managed': True,
                'indexes': [models.Index(fields=['board', 'user_id', 'created_at'], name='canvas_ai_jobs_board_user_idx'),
                            models.Index(fields=['parent_job'], name='canvas_ai_jobs_parent_idx')],
            },
        ),
    ]
