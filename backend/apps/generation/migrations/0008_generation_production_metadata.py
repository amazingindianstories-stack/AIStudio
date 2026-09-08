from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("generation", "0007_adopt_current_schema")]
    operations = [migrations.AddField(model_name="generation", name="production_metadata", field=models.JSONField(default=dict, db_default={}))]
