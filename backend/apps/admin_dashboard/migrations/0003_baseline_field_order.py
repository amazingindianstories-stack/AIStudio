from django.db import migrations
from apps.common.migration_operations.field_order import SetModelFieldOrder


class Migration(migrations.Migration):
    dependencies = [('admin_dashboard', '0002_pricing')]
    operations = [
        SetModelFieldOrder(name='UserLimit', fields=['user_id', 'key', 'value', 'updated_at', 'pk']),
    ]
