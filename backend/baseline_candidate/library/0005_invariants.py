from django.db import migrations
from apps.library.baseline_sql.foreign_key_aliases_v1 import STATEMENTS as ALIASES
from apps.library.baseline_sql.invariants_v1 import STATEMENTS as INVARIANTS


class Migration(migrations.Migration):
    dependencies = [('admin_dashboard', '0003_pricing'), ('agents', '0002_agentconversationmessage'), ('assets', '0003_portraitasset'), ('authentication', '0002_loginattempt'), ('canvas', '0001_canvasboard'), ('common', '0001_activitylog'), ('exports', '0002_mediaexportitem'), ('generation', '0001_generation'), ('library', '0004_generationnaming'), ('projects', '0001_project'), ('workers', '0001_depthworker')]
    operations = [migrations.RunSQL(sql=list(ALIASES + INVARIANTS))]
