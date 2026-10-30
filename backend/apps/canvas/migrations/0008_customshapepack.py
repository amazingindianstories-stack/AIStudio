"""Custom SVG shape packs uploaded by users and optionally shared with the organisation."""
import django.contrib.postgres.functions
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0007_canvasboardsave_changes')]
    operations = [
        migrations.CreateModel(
            name='CustomShapePack',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('name', models.TextField()),
                ('created_by', models.UUIDField()),
                ('shared', models.BooleanField(db_default=False)),
                ('show_names', models.BooleanField(db_default=True)),
                ('shapes', models.JSONField()),
                ('created_at', models.BigIntegerField()),
                ('updated_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'canvas_custom_shape_packs',
                'managed': True,
                'indexes': [
                    models.Index(fields=['created_by'], name='canvas_shape_packs_creator_idx'),
                    models.Index(fields=['shared', 'updated_at'], name='canvas_shape_packs_shared_idx'),
                ],
            },
        ),
        migrations.RunSQL("""
DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['goal4_green_preview_api', 'goal4_green_preview_worker'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON canvas_custom_shape_packs TO %I', r);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='goal4_green_history_writer') THEN
        GRANT SELECT ON canvas_custom_shape_packs TO goal4_green_history_writer;
    END IF;
END $$;
""", migrations.RunSQL.noop),
    ]
