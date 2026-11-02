"""Live facilitation (area D): the board timer, voting sessions and private mode."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models

TABLES = ('board_timers', 'board_voting_sessions', 'board_voting_votes', 'board_voting_done', 'board_private_mode')


class Migration(migrations.Migration):
    dependencies = [('canvas', '0014_collaboration')]
    operations = [
        migrations.CreateModel(
            name='BoardTimer',
            fields=[
                ('board_id', models.UUIDField(primary_key=True, serialize=False)),
                ('state', models.TextField(db_default='stopped')),
                ('duration_ms', models.BigIntegerField(db_default=0)),
                ('ends_at', models.BigIntegerField(null=True)),
                ('remaining_ms', models.BigIntegerField(null=True)),
                ('music', models.TextField(null=True)),
                ('started_by', models.UUIDField(null=True)),
                ('run', models.BigIntegerField(db_default=0)),
                ('updated_at', models.BigIntegerField()),
            ],
            options={'db_table': 'board_timers', 'managed': True,
                     'constraints': [models.CheckConstraint(condition=models.Q(state__in=('running', 'paused', 'stopped')), name='board_timers_state_check')]},
        ),
        migrations.CreateModel(
            name='VotingSession',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('board_id', models.UUIDField()),
                ('name', models.TextField()),
                ('status', models.TextField()),
                ('votes_per_person', models.IntegerField()),
                ('one_vote_per_object', models.BooleanField(db_default=False)),
                ('object_types', models.JSONField(null=True)),
                ('area', models.JSONField(null=True)),
                ('duration_ms', models.BigIntegerField(null=True)),
                ('started_at', models.BigIntegerField(null=True)),
                ('ends_at', models.BigIntegerField(null=True)),
                ('ended_at', models.BigIntegerField(null=True)),
                ('show_on_board', models.BooleanField(db_default=False)),
                ('created_by', models.UUIDField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={'db_table': 'board_voting_sessions', 'managed': True,
                     'indexes': [models.Index(fields=['board_id', '-created_at'], name='board_voting_board_idx')],
                     'constraints': [models.CheckConstraint(condition=models.Q(status__in=('saved', 'active', 'ended')), name='board_voting_status_check')]},
        ),
        migrations.CreateModel(
            name='VotingVote',
            fields=[
                ('pk', models.CompositePrimaryKey('session_id', 'user_id', 'node_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('session', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='canvas.votingsession')),
                ('user_id', models.UUIDField()),
                ('node_id', models.TextField()),
                ('votes', models.IntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={'db_table': 'board_voting_votes', 'managed': True,
                     'indexes': [models.Index(fields=['session', 'node_id'], name='board_voting_votes_node_idx')],
                     'constraints': [models.CheckConstraint(condition=models.Q(votes__gt=0), name='board_voting_votes_positive')]},
        ),
        migrations.CreateModel(
            name='VotingDone',
            fields=[
                ('pk', models.CompositePrimaryKey('session_id', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('session', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='canvas.votingsession')),
                ('user_id', models.UUIDField()),
                ('created_at', models.BigIntegerField()),
            ],
            options={'db_table': 'board_voting_done', 'managed': True},
        ),
        migrations.CreateModel(
            name='BoardPrivateMode',
            fields=[
                ('board_id', models.UUIDField(primary_key=True, serialize=False)),
                ('active', models.BooleanField(db_default=False)),
                ('anonymous', models.BooleanField(db_default=False)),
                ('allow_others_end', models.BooleanField(db_default=True)),
                ('started_by', models.UUIDField(null=True)),
                ('started_at', models.BigIntegerField(null=True)),
                ('reveal_at', models.BigIntegerField(null=True)),
                ('updated_at', models.BigIntegerField()),
            ],
            options={'db_table': 'board_private_mode', 'managed': True},
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['board_timers', 'board_voting_sessions', 'board_voting_votes', 'board_voting_done', 'board_private_mode'] LOOP
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
