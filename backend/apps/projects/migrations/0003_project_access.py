"""Project visibility. Existing projects get 'all', so nobody loses sight of anything."""
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('authentication', '0002_railway_v2_loginattempt'),
        ('projects', '0002_project_members'),
    ]

    operations = [
        migrations.AddField(model_name='project', name='access', field=models.TextField(default='all')),
        migrations.AddConstraint(model_name='project', constraint=models.CheckConstraint(
            condition=models.Q(('access__in', ('all', 'users', 'admin'))), name='projects_access_check')),
        migrations.CreateModel(
            name='ProjectAccessUser',
            fields=[
                ('pk', models.CompositePrimaryKey('project_id', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('created_at', models.BigIntegerField()),
                ('project', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, related_name='access_users', to='projects.project')),
                ('user', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='authentication.user')),
            ],
            options={
                'db_table': 'project_access_users',
                'managed': True,
                'indexes': [models.Index(fields=['user'], name='project_access_users_user_idx')],
            },
        ),
        migrations.RunSQL(sql="""
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON project_access_users TO %I', r);
    END IF;
  END LOOP;
END $$;
""", reverse_sql=migrations.RunSQL.noop),
    ]
