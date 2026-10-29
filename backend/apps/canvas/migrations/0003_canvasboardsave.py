"""Applied client save ids, kept 30 days, so a draft left behind by a save that landed is not replayed."""
import django.contrib.postgres.functions
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0002_canvasboard_version')]
    operations = [
        migrations.CreateModel(
            name='CanvasBoardSave',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('board_id', models.UUIDField()),
                ('save_id', models.UUIDField()),
                ('version', models.BigIntegerField()),
                ('applied_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_board_saves',
                'managed': True,
                'indexes': [models.Index(fields=['applied_at'], name='canvas_board_saves_applied_idx')],
                'constraints': [models.UniqueConstraint(fields=('board_id', 'save_id'), name='canvas_board_saves_board_save_key')],
            },
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, DELETE ON canvas_board_saves TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON canvas_board_saves TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
    ]
