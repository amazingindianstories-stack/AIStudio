from django.db import migrations

class Migration(migrations.Migration):
    dependencies = [('exports', '0002_railway_v2_mediaexportitem'), ('library', '0005_railway_v2_invariants')]
    operations = [migrations.RunSQL(sql="ALTER TABLE media_exports ALTER COLUMN id SET DEFAULT gen_random_uuid()", reverse_sql=None)]
