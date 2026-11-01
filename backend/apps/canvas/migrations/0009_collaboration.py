"""Board collaboration: comments, reactions, read markers, follows, notifications, presence, push subscriptions."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models

UUID = dict(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)


class Migration(migrations.Migration):
    dependencies = [('canvas', '0008_customshapepack')]
    operations = [
        migrations.AddField(model_name='canvasboard', name='collab_tools', field=models.TextField(db_default='edit')),
        migrations.AddConstraint(model_name='canvasboard', constraint=models.CheckConstraint(
            condition=models.Q(collab_tools__in=('edit', 'owner')), name='canvas_boards_collab_tools_check')),
        migrations.CreateModel(name='BoardComment', fields=[
            ('id', models.UUIDField(**UUID)),
            ('board_id', models.UUIDField()),
            ('author_id', models.UUIDField()),
            ('body', models.TextField()),
            ('color', models.TextField(null=True)),
            ('anchor_node_id', models.TextField(null=True)),
            ('anchor_dx', models.FloatField(null=True)),
            ('anchor_dy', models.FloatField(null=True)),
            ('x', models.FloatField(null=True)),
            ('y', models.FloatField(null=True)),
            ('mentions', models.JSONField(null=True)),
            ('resolved_at', models.BigIntegerField(null=True)),
            ('resolved_by', models.UUIDField(null=True)),
            ('deleted_at', models.BigIntegerField(null=True)),
            ('created_at', models.BigIntegerField()),
            ('updated_at', models.BigIntegerField()),
            ('edited_at', models.BigIntegerField(null=True)),
            ('parent', models.ForeignKey(db_column='parent_id', db_index=False, null=True,
                                         on_delete=django.db.models.deletion.CASCADE, to='canvas.boardcomment')),
        ], options={'db_table': 'board_comments', 'managed': True, 'indexes': [
            models.Index(fields=['board_id', 'updated_at'], name='board_comments_board_idx'),
            models.Index(fields=['parent'], name='board_comments_parent_idx')]}),
        migrations.CreateModel(name='CommentReaction', fields=[
            ('pk', models.CompositePrimaryKey('comment_id', 'user_id', 'emoji', blank=True, editable=False, primary_key=True, serialize=False)),
            ('user_id', models.UUIDField()),
            ('emoji', models.TextField()),
            ('created_at', models.BigIntegerField()),
            ('comment', models.ForeignKey(db_column='comment_id', db_index=False,
                                          on_delete=django.db.models.deletion.CASCADE, to='canvas.boardcomment')),
        ], options={'db_table': 'board_comment_reactions', 'managed': True}),
        migrations.CreateModel(name='CommentRead', fields=[
            ('pk', models.CompositePrimaryKey('user_id', 'comment_id', blank=True, editable=False, primary_key=True, serialize=False)),
            ('user_id', models.UUIDField()),
            ('comment', models.ForeignKey(db_column='comment_id', db_index=False,
                                          on_delete=django.db.models.deletion.CASCADE, to='canvas.boardcomment')),
        ], options={'db_table': 'board_comment_reads', 'managed': True, 'indexes': [
            models.Index(fields=['comment'], name='comment_reads_comment_idx')]}),
        migrations.CreateModel(name='CommentFollow', fields=[
            ('id', models.UUIDField(**UUID)),
            ('board_id', models.UUIDField()),
            ('user_id', models.UUIDField()),
            ('thread', models.ForeignKey(db_column='thread_id', db_index=False, null=True,
                                         on_delete=django.db.models.deletion.CASCADE, to='canvas.boardcomment')),
        ], options={'db_table': 'board_comment_follows', 'managed': True,
                    'indexes': [models.Index(fields=['board_id', 'user_id'], name='board_comment_follows_idx')],
                    'constraints': [
                        models.UniqueConstraint(fields=('board_id', 'user_id', 'thread'), name='board_comment_follows_thread_key',
                                                condition=models.Q(thread__isnull=False)),
                        models.UniqueConstraint(fields=('board_id', 'user_id'), name='board_comment_follows_all_key',
                                                condition=models.Q(thread__isnull=True))]}),
        migrations.CreateModel(name='Notification', fields=[
            ('id', models.UUIDField(**UUID)),
            ('user_id', models.UUIDField()),
            ('board_id', models.UUIDField()),
            ('kind', models.TextField()),
            ('comment_id', models.UUIDField(null=True)),
            ('thread_id', models.UUIDField(null=True)),
            ('actor_id', models.UUIDField(null=True)),
            ('snippet', models.TextField(null=True)),
            ('created_at', models.BigIntegerField()),
            ('read_at', models.BigIntegerField(null=True)),
            ('pushed_at', models.BigIntegerField(null=True)),
        ], options={'db_table': 'board_notifications', 'managed': True,
                    'indexes': [models.Index(fields=['user_id', '-created_at'], name='board_notifications_user_idx'),
                                models.Index(fields=['pushed_at', 'created_at'], name='board_notifications_push_idx'),
                                models.Index(fields=['created_at'], name='notifications_created_idx')],
                    'constraints': [models.CheckConstraint(condition=models.Q(kind__in=('comment', 'reply', 'mention')),
                                                           name='board_notifications_kind_check')]}),
        migrations.CreateModel(name='BoardPresence', fields=[
            ('pk', models.CompositePrimaryKey('board_id', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
            ('board_id', models.UUIDField()),
            ('user_id', models.UUIDField()),
            ('seen_at', models.BigIntegerField()),
        ], options={'db_table': 'board_presence', 'managed': True,
                    'indexes': [models.Index(fields=['seen_at'], name='board_presence_seen_idx')]}),
        migrations.CreateModel(name='PushSubscription', fields=[
            ('id', models.UUIDField(**UUID)),
            ('user_id', models.UUIDField()),
            ('endpoint', models.TextField(unique=True)),
            ('created_at', models.BigIntegerField()),
        ], options={'db_table': 'push_subscriptions', 'managed': True,
                    'indexes': [models.Index(fields=['user_id'], name='push_subscriptions_user_idx')]}),
        migrations.RunSQL("""
DO $$
DECLARE
    r TEXT;
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['board_comments', 'board_comment_reactions', 'board_comment_reads', 'board_comment_follows',
                             'board_notifications', 'board_presence', 'push_subscriptions'] LOOP
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
