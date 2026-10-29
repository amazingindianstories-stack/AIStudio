"""Per-project roles; additive, no rows are seeded, so existing projects keep today's access."""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('authentication', '0002_railway_v2_loginattempt'),
        ('projects', '0001_railway_v2_project'),
    ]

    operations = [
        migrations.CreateModel(
            name='ProjectMember',
            fields=[
                ('pk', models.CompositePrimaryKey('project_id', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('role', models.TextField()),
                ('added_by', models.UUIDField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
                ('project', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='projects.project')),
                ('user', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='authentication.user')),
            ],
            options={
                'db_table': 'project_members',
                'managed': True,
                'indexes': [models.Index(fields=['user'], name='project_members_user_idx')],
                'constraints': [models.CheckConstraint(condition=models.Q(('role__in', ('owner', 'co_owner', 'editor', 'commenter', 'viewer'))), name='project_members_role_check')],
            },
        ),
        migrations.RunSQL(sql="""
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON project_members TO %I', r);
    END IF;
  END LOOP;
END $$;
""", reverse_sql=migrations.RunSQL.noop),
    ]
