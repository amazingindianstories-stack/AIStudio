from django.db import migrations
from apps.common.migration_operations.field_order import SetModelFieldOrder


class Migration(migrations.Migration):
    dependencies = [('library', '0007_explicit_relation_index_state')]
    operations = [
        SetModelFieldOrder(name='Folder', fields=['id', 'project', 'parent', 'name', 'name_normalized', 'version', 'color', 'created_at', 'updated_at']),
        SetModelFieldOrder(name='GenerationNaming', fields=['generation', 'namespace', 'sequence', 'assigned_at']),
    ]
