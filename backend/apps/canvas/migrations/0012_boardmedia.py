"""Reusable board files and bounded worker rasterization queue."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0011_work_relation_kinds')]
    operations = [
        migrations.CreateModel(
            name='BoardMedia',
            fields=[
                ('id', models.UUIDField(primary_key=True, serialize=False, db_default=django.contrib.postgres.functions.RandomUUID())),
                ('board', models.ForeignKey(to='canvas.canvasboard', on_delete=django.db.models.deletion.CASCADE, db_index=False)),
                ('actor_id', models.UUIDField()), ('reference_id', models.UUIDField(null=True)),
                ('name', models.TextField()), ('content_type', models.TextField()), ('source_key', models.TextField()),
                ('key', models.TextField(default='')), ('state', models.TextField(default='queued')),
                ('pages', models.IntegerField(default=1)), ('width', models.IntegerField(default=0)),
                ('height', models.IntegerField(default=0)), ('error', models.TextField(default='')),
                ('lease_until', models.BigIntegerField(default=0)), ('lease_token', models.UUIDField(null=True)),
                ('attempts', models.IntegerField(default=0)),
                ('created_at', models.BigIntegerField()),
            ], options={'db_table': 'canvas_board_media',
                'indexes': [models.Index(fields=['state', 'created_at'], name='canvas_media_queue_idx'),
                            models.Index(fields=['board', '-created_at'], name='canvas_media_board_idx')],
                'constraints': [models.UniqueConstraint(fields=['board', 'reference_id'], name='canvas_media_upload_uniq'),
                    models.CheckConstraint(condition=models.Q(state__in=('queued', 'running', 'ready', 'failed')),
                                           name='canvas_media_state_check')]},
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_board_media TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON canvas_board_media TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
    ]
