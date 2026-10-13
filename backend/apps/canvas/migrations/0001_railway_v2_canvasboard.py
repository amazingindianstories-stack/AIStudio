import django.contrib.postgres.functions
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "canvas_boards" (\n"id" uuid DEFAULT gen_random_uuid() NOT NULL,\n"project_id" uuid NOT NULL,\n"name" text NOT NULL,\n"data" jsonb NOT NULL,\n"created_by" uuid,\n"created_at" bigint NOT NULL,\n"updated_at" bigint NOT NULL,\nCONSTRAINT "canvas_boards_pkey" PRIMARY KEY (id)\n)', 'CREATE INDEX canvas_boards_project_id_idx ON public.canvas_boards USING btree (project_id)'])], state_operations=[migrations.CreateModel(name='CanvasBoard', fields=[('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)), ('project_id', models.UUIDField()), ('name', models.TextField()), ('data', models.JSONField()), ('created_by', models.UUIDField(null=True)), ('created_at', models.BigIntegerField()), ('updated_at', models.BigIntegerField())], options={'db_table': 'canvas_boards', 'managed': True, 'indexes': [models.Index(fields=['project_id'], name='canvas_boards_project_id_idx')], 'constraints': []})])]
