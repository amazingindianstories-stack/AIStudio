from django.db import migrations
from apps.library.baseline_sql.foreign_key_aliases_v1 import STATEMENTS as ALIASES
from apps.library.baseline_sql.invariants_v1 import STATEMENTS as INVARIANTS


class Migration(migrations.Migration):
    dependencies = [('admin_dashboard', '0003_baseline_pricing'), ('agents', '0002_baseline_agentconversationmessage'), ('assets', '0003_baseline_portraitasset'), ('authentication', '0002_baseline_loginattempt'), ('canvas', '0001_baseline_canvasboard'), ('common', '0001_baseline_activitylog'), ('exports', '0002_baseline_mediaexportitem'), ('generation', '0001_baseline_generation'), ('library', '0004_baseline_generationnaming'), ('projects', '0001_baseline_project'), ('workers', '0001_baseline_depthworker')]
    operations = [migrations.RunSQL(sql=list(ALIASES + INVARIANTS))]
