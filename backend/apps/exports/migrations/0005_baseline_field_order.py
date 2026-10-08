from django.db import migrations
from apps.common.migration_operations.field_order import SetModelFieldOrder


class Migration(migrations.Migration):
    dependencies = [('exports', '0004_explicit_relation_index_state')]
    operations = [
        SetModelFieldOrder(name='MediaExportItem', fields=['export', 'generation_id', 'position', 'source_key', 'filename', 'pk']),
    ]
