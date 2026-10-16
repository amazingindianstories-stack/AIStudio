import apps.common.indexes
import django.contrib.postgres.functions
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "activity_logs" (\n"id" uuid DEFAULT gen_random_uuid() NOT NULL,\n"user_id" uuid,\n"action" text NOT NULL,\n"detail" jsonb,\n"created_at" bigint NOT NULL,\nCONSTRAINT "activity_logs_pkey" PRIMARY KEY (id)\n)', 'CREATE INDEX activity_logs_created_at_idx ON public.activity_logs USING btree (created_at)'])], state_operations=[migrations.CreateModel(name='ActivityLog', fields=[('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)), ('user_id', models.UUIDField(null=True)), ('action', models.TextField()), ('detail', models.JSONField(null=True)), ('created_at', models.BigIntegerField())], options={'db_table': 'activity_logs', 'managed': True, 'indexes': [apps.common.indexes.PostgreSQLIndex(models.OrderBy(models.F('created_at'), nulls_last=True), name='activity_logs_created_at_idx')], 'constraints': []})])]
