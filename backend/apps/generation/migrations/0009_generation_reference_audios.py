from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("generation", "0008_generation_production_metadata")]
    operations = [migrations.AddField(model_name="generation", name="reference_audios", field=models.JSONField(null=True))]
