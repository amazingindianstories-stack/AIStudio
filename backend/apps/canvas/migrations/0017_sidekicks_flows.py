"""Additive Sidekicks, Sidekick chats, board visits and Flow output history; one nullable column on board AI jobs."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models

UUID_PK = dict(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)


class Migration(migrations.Migration):
    dependencies = [('canvas', '0016_talktrack')]
    operations = [
        migrations.CreateModel(
            name='Sidekick',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('owner_id', models.UUIDField()),
                ('name', models.TextField()),
                ('description', models.TextField(db_default='')),
                ('instructions', models.TextField(db_default='')),
                ('starters', models.JSONField(default=list)),
                ('processing', models.TextField(db_default='basic')),
                ('knowledge', models.JSONField(default=list)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_sidekicks',
                'managed': True,
                'indexes': [models.Index(fields=['owner_id'], name='canvas_sidekicks_owner_idx')],
            },
        ),
        migrations.CreateModel(
            name='BoardSidekickChat',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('user_id', models.UUIDField()),
                ('sidekick', models.TextField()),
                ('title', models.TextField()),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
                ('board', models.ForeignKey(db_column='board_id', db_index=False, on_delete=django.db.models.deletion.CASCADE, to='canvas.canvasboard')),
            ],
            options={
                'db_table': 'canvas_sidekick_chats',
                'managed': True,
                'indexes': [models.Index(fields=['board', 'user_id', '-updated_at'], name='canvas_sk_chats_board_user_idx')],
            },
        ),
        migrations.AddField(
            model_name='boardaijob',
            name='chat',
            field=models.ForeignKey(db_column='chat_id', db_index=False, null=True, on_delete=django.db.models.deletion.SET_NULL, to='canvas.boardsidekickchat'),
        ),
        migrations.AddIndex(
            model_name='boardaijob',
            index=models.Index(fields=['chat', 'created_at'], name='canvas_ai_jobs_chat_idx'),
        ),
        migrations.CreateModel(
            name='BoardVisit',
            fields=[
                ('pk', models.CompositePrimaryKey('board_id', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('board_id', models.UUIDField()),
                ('user_id', models.UUIDField()),
                ('visited_at', models.BigIntegerField()),
            ],
            options={'db_table': 'canvas_board_visits', 'managed': True},
        ),
        migrations.CreateModel(
            name='FlowOutputVersion',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('board_id', models.UUIDField()),
                ('node_id', models.TextField()),
                ('user_id', models.UUIDField(null=True)),
                ('text', models.TextField()),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_flow_output_versions',
                'managed': True,
                'indexes': [models.Index(fields=['board_id', 'node_id', '-created_at'], name='canvas_flow_out_node_idx'),
                            models.Index(fields=['created_at'], name='canvas_flow_out_created_idx')],
            },
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['canvas_sidekicks', 'canvas_sidekick_chats', 'canvas_board_visits', 'canvas_flow_output_versions'] LOOP
        FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
                EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
            END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
            EXECUTE format('GRANT SELECT ON %I TO goal4_green_history_writer', t);
        END IF;
    END LOOP;
END $$;
""", migrations.RunSQL.noop),
    ]
