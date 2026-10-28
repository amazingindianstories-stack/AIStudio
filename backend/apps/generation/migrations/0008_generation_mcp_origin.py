"""Additive agent provenance: nullable columns with no backfill, plus a partial per-token spend index."""
from django.db import migrations, models
import apps.common.indexes


class Migration(migrations.Migration):
    dependencies = [('generation', '0007_explicit_folder_name_rename')]
    operations = [
        migrations.AddField(model_name='generation', name='created_via', field=models.TextField(null=True)),
        migrations.AddField(model_name='generation', name='mcp_token_id', field=models.UUIDField(null=True)),
        migrations.AddField(model_name='generation', name='mcp_client_id', field=models.UUIDField(null=True)),
        migrations.AddIndex(model_name='generation', index=apps.common.indexes.PostgreSQLIndex(
            condition=models.Q(mcp_token_id__isnull=False), fields=['mcp_token_id', 'created_at'],
            name='generations_mcp_token_created_idx')),
    ]
