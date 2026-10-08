from django.db import migrations
from apps.common.migration_operations.field_order import SetModelFieldOrder


class Migration(migrations.Migration):
    dependencies = [('assets', '0005_explicit_relation_index_state')]
    operations = [
        SetModelFieldOrder(name='PortraitAsset', fields=['id', 'group', 'byteplus_asset_id', 'name', 'asset_type', 'role', 'image_url', 'status', 'status_message', 'created_at', 'updated_at']),
    ]
