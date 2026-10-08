from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ('library', '0002_generationnaming_namingcounter_and_more'),
        ('projects', '0001_initial'),
        ('generation', '0001_initial'),
    ]

    operations = [
        migrations.RenameField(model_name='folder', old_name='project_id', new_name='project'),
        migrations.AlterField(model_name='folder', name='project', field=models.ForeignKey(to='projects.project', on_delete=django.db.models.deletion.RESTRICT, db_column='project_id', null=True)),
        migrations.RenameField(model_name='folder', old_name='parent_id', new_name='parent'),
        migrations.AlterField(model_name='folder', name='parent', field=models.ForeignKey(to='library.folder', on_delete=django.db.models.deletion.RESTRICT, db_column='parent_id', null=True)),
        migrations.RenameField(model_name='generationnaming', old_name='generation_id', new_name='generation'),
        migrations.AlterField(model_name='generationnaming', name='generation', field=models.OneToOneField(to='generation.generation', on_delete=django.db.models.deletion.CASCADE, db_column='generation_id', primary_key=True, serialize=False)),
    ]
