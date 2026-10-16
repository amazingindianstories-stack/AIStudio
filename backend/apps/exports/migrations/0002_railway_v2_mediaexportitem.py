import apps.common.indexes
import django.db.models.deletion
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = [('exports', '0001_railway_v2_mediaexport')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[migrations.RunSQL(sql=['CREATE TABLE "media_export_items" (\n"export_id" uuid NOT NULL,\n"generation_id" uuid NOT NULL,\n"position" integer NOT NULL,\n"source_key" text NOT NULL,\n"filename" text NOT NULL,\nCONSTRAINT "media_export_items_pkey" PRIMARY KEY (export_id, generation_id)\n)', 'CREATE INDEX media_export_items_order_idx ON public.media_export_items USING btree (export_id, "position")'])], state_operations=[migrations.CreateModel(name='MediaExportItem', fields=[('export', models.ForeignKey(db_column='export_id', db_index=False, on_delete=django.db.models.deletion.CASCADE, to='exports.mediaexport')), ('generation_id', models.UUIDField()), ('position', models.IntegerField()), ('source_key', models.TextField()), ('filename', models.TextField()), ('pk', models.CompositePrimaryKey('export_id', 'generation_id', blank=True, editable=False, primary_key=True, serialize=False))], options={'db_table': 'media_export_items', 'managed': True, 'indexes': [apps.common.indexes.PostgreSQLIndex(models.OrderBy(models.F('export'), nulls_last=True), models.OrderBy(models.F('position'), nulls_last=True), name='media_export_items_order_idx')], 'constraints': []})])]
