import apps.common.indexes
import django.contrib.postgres.functions
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = [('authentication', '0001_railway_v2_user')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "login_attempts" (\n"id" uuid DEFAULT gen_random_uuid() NOT NULL,\n"identifier" text NOT NULL,\n"created_at" bigint NOT NULL,\nCONSTRAINT "login_attempts_pkey" PRIMARY KEY (id)\n)', 'CREATE INDEX login_attempts_identifier_created_idx ON public.login_attempts USING btree (identifier, created_at)'])], state_operations=[migrations.CreateModel(name='LoginAttempt', fields=[('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)), ('identifier', models.TextField()), ('created_at', models.BigIntegerField())], options={'db_table': 'login_attempts', 'managed': True, 'indexes': [apps.common.indexes.PostgreSQLIndex(models.OrderBy(models.F('identifier'), nulls_last=True), models.OrderBy(models.F('created_at'), nulls_last=True), name='login_attempts_identifier_created_idx')], 'constraints': []})])]
