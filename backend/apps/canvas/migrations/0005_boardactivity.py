"""Board activity: what each graph save added, edited or deleted, kept 90 days."""
import django.contrib.postgres.functions
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0004_canvasboardsave')]
    operations = [
        migrations.CreateModel(
            name='BoardActivity',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('board_id', models.UUIDField()),
                ('actor_id', models.UUIDField(null=True)),
                ('action', models.TextField()),
                ('node_id', models.TextField()),
                ('node_type', models.TextField()),
                ('snippet', models.TextField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('ordinal', models.IntegerField()),
            ],
            options={
                'db_table': 'board_activity',
                'managed': True,
                'indexes': [models.Index(fields=['board_id', '-created_at', '-ordinal'], name='board_activity_board_idx'),
                            models.Index(fields=['created_at'], name='board_activity_created_idx')],
                'constraints': [models.CheckConstraint(condition=models.Q(('action__in', ('add', 'edit', 'delete'))), name='board_activity_action_check')],
            },
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, DELETE ON board_activity TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON board_activity TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
    ]
