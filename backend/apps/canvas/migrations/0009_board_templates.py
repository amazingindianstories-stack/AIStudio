"""Custom board templates, blueprints, and their usage counts, likes and comments."""
import django.contrib.postgres.functions
from django.db import migrations, models

TABLES = ('canvas_board_templates', 'canvas_blueprints', 'canvas_template_usage', 'canvas_template_likes',
          'canvas_template_comments')


def grants():
    api_writes = ' '.join(
        f"EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO %I', r);" for table in TABLES)
    history = ' '.join(f'GRANT SELECT ON {table} TO goal4_green_history_writer;' for table in TABLES)
    return f"""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            {api_writes}
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        {history}
    END IF;
END $$;
"""


def uuid_pk():
    return models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)


class Migration(migrations.Migration):
    dependencies = [('canvas', '0008_customshapepack')]
    operations = [
        migrations.CreateModel(
            name='BoardTemplate',
            fields=[
                ('id', uuid_pk()),
                ('name', models.TextField()),
                ('description', models.TextField(db_default='')),
                ('category', models.TextField(db_default='other')),
                ('tags', models.JSONField(default=list)),
                ('scope', models.TextField(db_default='personal')),
                ('project_id', models.UUIDField(null=True)),
                ('created_by', models.UUIDField(null=True)),
                ('featured', models.BooleanField(db_default=False)),
                ('graph', models.JSONField()),
                ('preview', models.JSONField(default=dict)),
                ('node_count', models.IntegerField(db_default=0)),
                ('board_id', models.UUIDField(null=True)),
                ('default_view', models.TextField(null=True)),
                ('deleted_at', models.BigIntegerField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_board_templates',
                'managed': True,
                'indexes': [
                    models.Index(fields=['scope', 'project_id'], name='canvas_templates_scope_idx'),
                    models.Index(fields=['created_by'], name='canvas_templates_creator_idx'),
                    models.Index(fields=['board_id'], name='canvas_templates_board_idx'),
                ],
                'constraints': [models.CheckConstraint(condition=models.Q(scope__in=('personal', 'project', 'everyone')),
                                                       name='canvas_templates_scope_check')],
            },
        ),
        migrations.CreateModel(
            name='Blueprint',
            fields=[
                ('id', uuid_pk()),
                ('name', models.TextField()),
                ('description', models.TextField(db_default='')),
                ('scope', models.TextField(db_default='personal')),
                ('project_id', models.UUIDField(null=True)),
                ('created_by', models.UUIDField(null=True)),
                ('featured', models.BooleanField(db_default=False)),
                ('boards', models.JSONField()),
                ('deleted_at', models.BigIntegerField(null=True)),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_blueprints',
                'managed': True,
                'indexes': [models.Index(fields=['scope', 'project_id'], name='canvas_blueprints_scope_idx')],
                'constraints': [models.CheckConstraint(condition=models.Q(scope__in=('personal', 'project', 'everyone')),
                                                       name='canvas_blueprints_scope_check')],
            },
        ),
        migrations.CreateModel(
            name='BoardTemplateUsage',
            fields=[
                ('id', uuid_pk()),
                ('template_ref', models.TextField()),
                ('kind', models.TextField()),
                ('name', models.TextField()),
                ('user_id', models.UUIDField(null=True)),
                ('board_id', models.UUIDField(null=True)),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_template_usage',
                'managed': True,
                'indexes': [
                    models.Index(fields=['created_at'], name='canvas_template_usage_at_idx'),
                    models.Index(fields=['template_ref', 'created_at'], name='canvas_template_usage_ref_idx'),
                ],
            },
        ),
        migrations.CreateModel(
            name='BoardTemplateLike',
            fields=[
                ('pk', models.CompositePrimaryKey('template_ref', 'user_id', blank=True, editable=False, primary_key=True, serialize=False)),
                ('template_ref', models.TextField()),
                ('user_id', models.UUIDField()),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_template_likes',
                'managed': True,
                'indexes': [models.Index(fields=['user_id'], name='canvas_template_likes_user_idx')],
            },
        ),
        migrations.CreateModel(
            name='BoardTemplateComment',
            fields=[
                ('id', uuid_pk()),
                ('template_ref', models.TextField()),
                ('user_id', models.UUIDField(null=True)),
                ('body', models.TextField()),
                ('created_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_template_comments',
                'managed': True,
                'indexes': [models.Index(fields=['template_ref', 'created_at'], name='canvas_template_comments_idx')],
            },
        ),
        migrations.RunSQL(grants(), migrations.RunSQL.noop),
    ]
