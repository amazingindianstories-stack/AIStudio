"""The thinking level a run's model steps use: one column with a database default, so runs inserted without it keep
the fixed level they had before."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('agents', '0006_inbox_composer')]
    operations = [
        migrations.AddField(model_name='agentrun', name='thinking_level',
                            field=models.TextField(default='MEDIUM', db_default='MEDIUM')),
    ]
