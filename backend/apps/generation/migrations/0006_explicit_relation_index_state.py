from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('generation', '0005_declared_default_state')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[], state_operations=[
                migrations.AlterField(model_name='generation', name='project', field=models.ForeignKey('projects.Project', on_delete=models.RESTRICT, db_column='project_id', null=True, db_index=False)),
                migrations.AlterField(model_name='generation', name='folder', field=models.ForeignKey('library.Folder', on_delete=models.RESTRICT, db_column='folder_id', null=True, db_index=False)),
    ])]
