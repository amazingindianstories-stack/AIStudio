import django.contrib.postgres.functions
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "projects" (\n"id" uuid DEFAULT gen_random_uuid() NOT NULL,\n"name" text NOT NULL,\n"brief" text,\n"created_by" uuid,\n"created_at" bigint NOT NULL,\n"updated_at" bigint NOT NULL,\nCONSTRAINT "projects_pkey" PRIMARY KEY (id)\n)'])], state_operations=[migrations.CreateModel(name='Project', fields=[('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)), ('name', models.TextField()), ('brief', models.TextField(null=True)), ('created_by', models.UUIDField(null=True)), ('created_at', models.BigIntegerField()), ('updated_at', models.BigIntegerField())], options={'db_table': 'projects', 'managed': True, 'indexes': [], 'constraints': []})])]
