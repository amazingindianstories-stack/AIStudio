"""Keep explicit dependencies apart from dependencies derived from relation fields."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('canvas', '0010_work_permissions')]
    operations = [
        migrations.RemoveConstraint(model_name='workrelation', name='work_relation_kind_check'),
        migrations.AddConstraint(model_name='workrelation', constraint=models.CheckConstraint(
            condition=models.Q(('kind__in', ['blocked_by', 'relation'])), name='work_relation_kind_check')),
    ]
