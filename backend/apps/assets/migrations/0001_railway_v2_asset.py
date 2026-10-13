import apps.common.indexes
import django.contrib.postgres.functions
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "assets" (\n"id" uuid DEFAULT gen_random_uuid() NOT NULL,\n"kind" text NOT NULL,\n"name" text NOT NULL,\n"slug" text NOT NULL,\n"description" text,\n"images" jsonb DEFAULT \'[]\'::jsonb NOT NULL,\n"created_at" bigint NOT NULL,\n"updated_at" bigint NOT NULL,\n"project_id" uuid,\nCONSTRAINT "assets_pkey" PRIMARY KEY (id)\n)', 'CREATE INDEX assets_project_id_idx ON public.assets USING btree (project_id)'])], state_operations=[migrations.CreateModel(name='Asset', fields=[('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)), ('kind', models.TextField()), ('name', models.TextField()), ('slug', models.TextField()), ('description', models.TextField(null=True)), ('images', models.JSONField(db_default=[])), ('created_at', models.BigIntegerField()), ('updated_at', models.BigIntegerField()), ('project_id', models.UUIDField(null=True))], options={'db_table': 'assets', 'managed': True, 'indexes': [apps.common.indexes.PostgreSQLIndex(models.OrderBy(models.F('project_id'), nulls_last=True), name='assets_project_id_idx')], 'constraints': []})])]
