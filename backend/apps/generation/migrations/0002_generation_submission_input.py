"""Additive durable provider input; legacy rows intentionally remain NULL."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0001_baseline_generation')]

    operations = [
        migrations.AddField(
            model_name='generation', name='submission_input',
            field=models.JSONField(null=True),
        ),
    ]
