from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = [('admin_dashboard', '0002_railway_v2_userlimit')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "pricing" (\n"model" text NOT NULL,\n"unit_cost_cents" integer NOT NULL,\n"unit" text NOT NULL,\n"notes" text,\nCONSTRAINT "pricing_pkey" PRIMARY KEY (model)\n)'])], state_operations=[migrations.CreateModel(name='Pricing', fields=[('model', models.TextField(primary_key=True, serialize=False)), ('unit_cost_cents', models.IntegerField()), ('unit', models.TextField()), ('notes', models.TextField(null=True))], options={'db_table': 'pricing', 'managed': True, 'indexes': [], 'constraints': []})])]
