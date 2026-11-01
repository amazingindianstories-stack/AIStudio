"""Talktrack (area D): recorded board walk-throughs, who watched them, and reactions and comments on them."""
import django.db.models.deletion
from django.db import migrations, models

TABLES = ('board_talktracks', 'board_talktrack_views', 'board_talktrack_moments')


class Migration(migrations.Migration):
    dependencies = [('canvas', '0009_facilitation')]
    operations = [
        migrations.CreateModel(
            name='Talktrack',
            fields=[
                ('id', models.UUIDField(primary_key=True, serialize=False)),
                ('board_id', models.UUIDField(db_index=True)),
                ('owner_id', models.UUIDField(db_index=True)),
                ('title', models.TextField()),
                ('key', models.TextField()),
                ('mime', models.TextField()),
                ('size', models.BigIntegerField()),
                ('duration_ms', models.BigIntegerField()),
                ('trim_start_ms', models.BigIntegerField(db_default=0)),
                ('trim_end_ms', models.BigIntegerField(null=True)),
                ('status', models.TextField(db_default='ready')),
                ('cut_start_ms', models.BigIntegerField(null=True)),
                ('cut_end_ms', models.BigIntegerField(null=True)),
                ('audio_key', models.TextField(null=True)),
                ('transcript', models.JSONField(null=True)),
                ('summary', models.TextField(null=True)),
                ('chapters', models.JSONField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={'db_table': 'board_talktracks', 'managed': True},
        ),
        migrations.CreateModel(
            name='TalktrackView',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('user_id', models.UUIDField()),
                ('first_at', models.BigIntegerField()),
                ('last_at', models.BigIntegerField()),
                ('watched_ms', models.BigIntegerField(db_default=0)),
                ('completed', models.BooleanField(db_default=False)),
                ('talktrack', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='views', to='canvas.talktrack')),
            ],
            options={'db_table': 'board_talktrack_views', 'managed': True,
                     'constraints': [models.UniqueConstraint(fields=('talktrack', 'user_id'), name='talktrack_view_one_per_user')]},
        ),
        migrations.CreateModel(
            name='TalktrackMoment',
            fields=[
                ('id', models.UUIDField(primary_key=True, serialize=False)),
                ('user_id', models.UUIDField()),
                ('at_ms', models.BigIntegerField()),
                ('emoji', models.TextField(db_default='')),
                ('text', models.TextField(db_default='')),
                ('created_at', models.BigIntegerField()),
                ('talktrack', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='moments', to='canvas.talktrack')),
            ],
            options={'db_table': 'board_talktrack_moments', 'managed': True},
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['board_talktracks', 'board_talktrack_views', 'board_talktrack_moments'] LOOP
        FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
                EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', t, r);
            END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
            EXECUTE format('GRANT SELECT ON %I TO goal4_green_history_writer', t);
        END IF;
    END LOOP;
    FOR r IN SELECT unnest(ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker']) LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE board_talktrack_views_id_seq TO %I', r);
        END IF;
    END LOOP;
END $$;
""", migrations.RunSQL.noop),
    ]
