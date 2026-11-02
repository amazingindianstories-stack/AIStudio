"""On-demand WebVTT captions for board videos, stored outside the board JSON."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0017_sidekicks_flows')]
    operations = [
        migrations.CreateModel(
            name='BoardCaption',
            fields=[
                ('id', models.UUIDField(primary_key=True, serialize=False, db_default=django.contrib.postgres.functions.RandomUUID())),
                ('board', models.ForeignKey(to='canvas.canvasboard', on_delete=django.db.models.deletion.CASCADE, db_index=False)),
                ('actor_id', models.UUIDField()),
                ('media_key', models.TextField()),
                ('vtt', models.TextField(default='')),
                ('created_at', models.BigIntegerField()),
            ], options={'db_table': 'canvas_board_captions',
                'constraints': [models.UniqueConstraint(fields=['board', 'media_key'], name='canvas_caption_media_uniq')]},
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_board_captions TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON canvas_board_captions TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
    ]
