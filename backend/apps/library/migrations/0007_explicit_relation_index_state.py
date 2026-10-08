from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('library', '0006_declared_default_state')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[], state_operations=[
                migrations.AlterField(model_name='folder', name='project', field=models.ForeignKey('projects.Project', on_delete=models.RESTRICT, db_column='project_id', null=True, db_index=False)),
                migrations.AlterField(model_name='folder', name='parent', field=models.ForeignKey('library.Folder', on_delete=models.RESTRICT, db_column='parent_id', null=True, db_index=False)),
                migrations.AlterField(model_name='generationnaming', name='generation', field=models.OneToOneField('generation.Generation', on_delete=models.CASCADE, db_column='generation_id', primary_key=True, db_index=False)),
    ])]
