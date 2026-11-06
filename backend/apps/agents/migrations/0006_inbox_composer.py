"""The composer context (mode, model, settings, location) an inbox message was sent with: one nullable column, so
images without it keep inserting."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('agents', '0005_agent_runs')]
    operations = [
        migrations.AddField(model_name='agentinboxmessage', name='composer', field=models.JSONField(null=True)),
    ]
