from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = [('library', '0001_railway_v2_folder')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "naming_counters" (\n"namespace" text NOT NULL,\n"next_sequence" bigint DEFAULT 1 NOT NULL,\n"updated_at" bigint NOT NULL,\nCONSTRAINT "naming_counters_pkey" PRIMARY KEY (namespace)\n)'])], state_operations=[migrations.CreateModel(name='NamingCounter', fields=[('namespace', models.TextField(primary_key=True, serialize=False)), ('next_sequence', models.BigIntegerField(db_default=1, default=1)), ('updated_at', models.BigIntegerField())], options={'db_table': 'naming_counters', 'managed': True, 'indexes': [], 'constraints': []})])]
