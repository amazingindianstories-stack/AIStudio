from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "settings" (\n"key" text NOT NULL,\n"value" text NOT NULL,\n"updated_at" bigint NOT NULL,\nCONSTRAINT "settings_pkey" PRIMARY KEY (key)\n)'])], state_operations=[migrations.CreateModel(name='AppSetting', fields=[('key', models.TextField(primary_key=True, serialize=False)), ('value', models.TextField()), ('updated_at', models.BigIntegerField())], options={'db_table': 'settings', 'managed': True, 'indexes': [], 'constraints': []})])]
