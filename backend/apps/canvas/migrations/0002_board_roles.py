"""Per-board roles; additive. Existing and new boards keep team access 'edit', so every signed-in
teammate keeps today's open/save access until the board owner narrows it."""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('authentication', '0002_railway_v2_loginattempt'),
        ('canvas', '0001_railway_v2_canvasboard'),
    ]

    operations = [
        migrations.AddField(
            model_name='canvasboard',
            name='team_role',
            field=models.TextField(db_default='edit'),
        ),
        migrations.AddConstraint(
            model_name='canvasboard',
            constraint=models.CheckConstraint(condition=models.Q(('team_role__in', ('edit', 'comment', 'view'))), name='canvas_boards_team_role_check'),
        ),
        migrations.CreateModel(
            name='BoardMember',
            fields=[
                ('pk', models.CompositePrimaryKey('board_id', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('role', models.TextField()),
                ('added_by', models.UUIDField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
                ('board', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='canvas.canvasboard')),
                ('user', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='authentication.user')),
            ],
            options={
                'db_table': 'board_members',
                'managed': True,
                'indexes': [models.Index(fields=['user'], name='board_members_user_idx')],
                'constraints': [models.CheckConstraint(condition=models.Q(('role__in', ('edit', 'comment', 'view'))), name='board_members_role_check')],
            },
        ),
        migrations.RunSQL(sql="""
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON board_members TO %I', r);
    END IF;
  END LOOP;
END $$;
""", reverse_sql=migrations.RunSQL.noop),
    ]
