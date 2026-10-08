from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('assets', '0004_declared_default_state')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[], state_operations=[
                migrations.AlterField(model_name='portraitasset', name='group', field=models.ForeignKey('assets.PortraitGroup', on_delete=models.CASCADE, db_column='group_id', db_index=False)),
    ])]
