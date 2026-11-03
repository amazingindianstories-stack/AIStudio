"""The Gemini agent's tables: grants, runs, the step journal, run events, the inbox, chat assets and the LLM usage ledger.

Additive only. The columns are plain UUIDs, as elsewhere in the schema; the foreign keys live in the database:
deleting a conversation cascades to its runs (and their steps and events), inbox and chat assets, and sets the usage
ledger's conversation and run ids to NULL. A run's grant is never deleted (grants are revoked). Every table is
granted explicitly to the API and worker roles, and SELECT to the history role, as canvas 0017 does: production has
no default privileges, and no migration in this graph defines row-level security.
"""
import django.contrib.postgres.functions
from django.db import migrations, models

UUID_PK = dict(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)
FOREIGN_KEYS = (
    ('agent_runs', 'conversation_id', 'agent_conversations', 'CASCADE'),
    ('agent_runs', 'grant_id', 'agent_grants', 'RESTRICT'),
    ('agent_run_steps', 'run_id', 'agent_runs', 'CASCADE'),
    ('agent_run_events', 'run_id', 'agent_runs', 'CASCADE'),
    ('agent_inbox', 'conversation_id', 'agent_conversations', 'CASCADE'),
    ('agent_chat_assets', 'conversation_id', 'agent_conversations', 'CASCADE'),
    ('agent_llm_usage', 'conversation_id', 'agent_conversations', 'SET NULL'),
    ('agent_llm_usage', 'run_id', 'agent_runs', 'SET NULL'),
)


class Migration(migrations.Migration):
    dependencies = [('agents', '0004_message_conversation_fk')]
    operations = [
        migrations.CreateModel(
            name='AgentGrant',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('user_id', models.UUIDField()),
                ('scopes', models.JSONField()),
                ('daily_cap_cents', models.IntegerField()),
                ('auto_approve_cents', models.IntegerField()),
                ('auth_version_at_issue', models.IntegerField()),
                ('created_at', models.BigIntegerField()),
                ('revoked_at', models.BigIntegerField(null=True)),
                ('revoked_by', models.UUIDField(null=True)),
            ],
            options={
                'db_table': 'agent_grants',
                'managed': True,
                'constraints': [models.UniqueConstraint(condition=models.Q(('revoked_at__isnull', True)), fields=('user_id',), name='agent_grants_live_user_uniq')],
            },
        ),
        migrations.CreateModel(
            name='AgentRun',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('conversation_id', models.UUIDField()),
                ('user_id', models.UUIDField()),
                ('grant_id', models.UUIDField()),
                ('status', models.TextField(db_default='queued', default='queued')),
                ('model', models.TextField()),
                ('step_count', models.IntegerField(db_default=0, default=0)),
                ('cost_cents', models.IntegerField(db_default=0, default=0)),
                ('pause_reason', models.TextField(null=True)),
                ('resume_after', models.BigIntegerField(null=True)),
                ('error', models.JSONField(null=True)),
                ('cancel_requested_at', models.BigIntegerField(null=True)),
                ('cancel_jobs', models.BooleanField(db_default=False, default=False)),
                ('last_heartbeat_at', models.BigIntegerField(null=True)),
                ('started_at', models.BigIntegerField(null=True)),
                ('finished_at', models.BigIntegerField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'agent_runs',
                'managed': True,
                'indexes': [models.Index(fields=['conversation_id', '-created_at'], name='agent_runs_conversation_idx'), models.Index(fields=['user_id', 'status'], name='agent_runs_user_status_idx'), models.Index(condition=models.Q(('status__in', ('queued', 'running', 'waiting_approval', 'waiting_jobs', 'paused_limit'))), fields=['status', 'updated_at'], name='agent_runs_active_idx')],
                'constraints': [models.UniqueConstraint(condition=models.Q(('status__in', ('queued', 'running', 'waiting_approval', 'waiting_jobs', 'paused_limit'))), fields=('conversation_id',), name='agent_runs_one_active_uniq')],
            },
        ),
        migrations.CreateModel(
            name='AgentRunStep',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('run_id', models.UUIDField()),
                ('step_index', models.IntegerField()),
                ('kind', models.TextField()),
                ('tool_name', models.TextField(null=True)),
                ('input_hash', models.TextField()),
                ('idempotency_key', models.TextField(null=True)),
                ('status', models.TextField(db_default='started', default='started')),
                ('outcome', models.TextField(null=True)),
                ('result', models.JSONField(null=True)),
                ('cost_cents', models.IntegerField(db_default=0, default=0)),
                ('started_at', models.BigIntegerField()),
                ('finished_at', models.BigIntegerField(null=True)),
            ],
            options={
                'db_table': 'agent_run_steps',
                'managed': True,
                'constraints': [models.UniqueConstraint(fields=('run_id', 'step_index'), name='agent_run_steps_run_step_uniq')],
            },
        ),
        migrations.CreateModel(
            name='AgentRunEvent',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('run_id', models.UUIDField()),
                ('seq', models.IntegerField()),
                ('kind', models.TextField()),
                ('payload', models.JSONField(db_default={}, default=dict)),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'agent_run_events',
                'managed': True,
                'constraints': [models.UniqueConstraint(fields=('run_id', 'seq'), name='agent_run_events_run_seq_uniq')],
            },
        ),
        migrations.CreateModel(
            name='AgentInboxMessage',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('conversation_id', models.UUIDField()),
                ('run_id', models.UUIDField(null=True)),
                ('user_id', models.UUIDField()),
                ('content', models.TextField()),
                ('attachments', models.JSONField(db_default=[], default=list)),
                ('created_at', models.BigIntegerField()),
                ('delivered_at', models.BigIntegerField(null=True)),
                ('delivered_step', models.IntegerField(null=True)),
            ],
            options={
                'db_table': 'agent_inbox',
                'managed': True,
                'indexes': [models.Index(fields=['conversation_id', 'created_at'], name='agent_inbox_conversation_idx'), models.Index(condition=models.Q(('delivered_at__isnull', True)), fields=['run_id', 'created_at'], name='agent_inbox_pending_idx')],
            },
        ),
        migrations.CreateModel(
            name='AgentChatAsset',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('conversation_id', models.UUIDField()),
                ('asset_id', models.UUIDField()),
                ('source', models.TextField()),
                ('kind', models.TextField()),
                ('run_id', models.UUIDField(null=True)),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'agent_chat_assets',
                'managed': True,
                'constraints': [models.UniqueConstraint(fields=('conversation_id', 'asset_id'), name='agent_chat_assets_conversation_asset_uniq')],
            },
        ),
        migrations.CreateModel(
            name='AgentLlmUsage',
            fields=[
                ('id', models.UUIDField(**UUID_PK)),
                ('user_id', models.UUIDField()),
                ('grant_id', models.UUIDField(null=True)),
                ('conversation_id', models.UUIDField(null=True)),
                ('run_id', models.UUIDField(null=True)),
                ('step_index', models.IntegerField(null=True)),
                ('model', models.TextField()),
                ('purpose', models.TextField()),
                ('prompt_tokens', models.IntegerField()),
                ('cached_tokens', models.IntegerField()),
                ('output_tokens', models.IntegerField()),
                ('thoughts_tokens', models.IntegerField()),
                ('tool_prompt_tokens', models.IntegerField()),
                ('total_tokens', models.IntegerField()),
                ('cost_microcents', models.BigIntegerField()),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'agent_llm_usage',
                'managed': True,
                'indexes': [models.Index(fields=['user_id', 'created_at'], name='agent_llm_usage_user_idx'), models.Index(fields=['created_at'], name='agent_llm_usage_created_idx'), models.Index(fields=['conversation_id'], name='agent_llm_usage_conv_idx'), models.Index(fields=['run_id'], name='agent_llm_usage_run_idx')],
            },
        ),
        *(migrations.RunSQL(f'ALTER TABLE {table} ADD CONSTRAINT {table}_{column}_fkey FOREIGN KEY ({column}) '
                            f'REFERENCES {target}(id) ON DELETE {action}',
                            f'ALTER TABLE {table} DROP CONSTRAINT {table}_{column}_fkey')
          for table, column, target, action in FOREIGN_KEYS),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['agent_grants', 'agent_runs', 'agent_run_steps', 'agent_run_events', 'agent_inbox', 'agent_chat_assets', 'agent_llm_usage'] LOOP
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
