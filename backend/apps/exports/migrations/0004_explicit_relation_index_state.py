from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('exports', '0003_declared_default_state')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[], state_operations=[
                migrations.AlterField(model_name='mediaexportitem', name='export', field=models.ForeignKey('exports.MediaExport', on_delete=models.CASCADE, db_column='export_id', db_index=False)),
    ])]
