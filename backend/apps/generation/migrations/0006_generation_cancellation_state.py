from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0005_generation_name_owner')]
    operations = [migrations.AddField(model_name='generation', name='cancellation_state',
                                     field=models.TextField(null=True))]
