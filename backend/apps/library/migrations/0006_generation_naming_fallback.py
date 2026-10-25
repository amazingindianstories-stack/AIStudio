"""Record when a finalized Unsorted draft could not keep its provisional name."""
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('library', '0005_railway_v2_invariants')]
    operations = [
        migrations.AddField(model_name='generationnaming', name='fallback_from_name', field=models.TextField(null=True)),
        migrations.AddField(model_name='generationnaming', name='fallback_reason', field=models.TextField(null=True)),
    ]
