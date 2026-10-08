from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('library', '0004_declared_index_state')]
    operations = [migrations.SeparateDatabaseAndState(database_operations=[], state_operations=[
        migrations.AddConstraint(model_name='folder', constraint=models.CheckConstraint(name='folders_color_check', condition=models.Q(color__isnull=True) | models.Q(color__in=['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']))),
        migrations.AddConstraint(model_name='generationnaming', constraint=models.CheckConstraint(name='generation_naming_sequence_check', condition=models.Q(sequence__gt=0))),
    ])]
