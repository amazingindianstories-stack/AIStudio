from django.db import migrations
from apps.common.migration_operations.field_order import SetModelFieldOrder


class Migration(migrations.Migration):
    dependencies = [('authentication', '0006_declared_default_state')]
    operations = [
        SetModelFieldOrder(name='User', fields=['id', 'email', 'password_hash', 'password_salt', 'name', 'role', 'color', 'avatar_url', 'is_active', 'auth_version', 'created_at']),
    ]
