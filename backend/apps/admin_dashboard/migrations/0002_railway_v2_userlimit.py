from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = [('admin_dashboard', '0001_railway_v2_appsetting')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "user_limits" (\n"user_id" uuid NOT NULL,\n"key" text NOT NULL,\n"value" text NOT NULL,\n"updated_at" bigint NOT NULL,\nCONSTRAINT "user_limits_user_id_key_pk" PRIMARY KEY (user_id, key)\n)'])], state_operations=[migrations.CreateModel(name='UserLimit', fields=[('user_id', models.UUIDField()), ('key', models.TextField()), ('value', models.TextField()), ('updated_at', models.BigIntegerField()), ('pk', models.CompositePrimaryKey('user_id', 'key', blank=True, editable=False, primary_key=True, serialize=False))], options={'db_table': 'user_limits', 'managed': True, 'indexes': [], 'constraints': []})])]
