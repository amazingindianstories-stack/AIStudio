"""Agent (MCP) identity tables; additive, no existing rows change."""
import django.contrib.postgres.functions
import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('authentication', '0002_railway_v2_loginattempt'),
    ]

    operations = [
        migrations.CreateModel(
            name='McpClient',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('client_id', models.TextField(unique=True)),
                ('kind', models.TextField()),
                ('client_name', models.TextField()),
                ('client_uri', models.TextField(null=True)),
                ('logo_uri', models.TextField(null=True)),
                ('redirect_uris', models.JSONField()),
                ('created_at', models.BigIntegerField()),
                ('fetched_at', models.BigIntegerField(null=True)),
                ('last_authorized_at', models.BigIntegerField(null=True)),
            ],
            options={
                'db_table': 'mcp_clients',
                'constraints': [models.CheckConstraint(condition=models.Q(('kind__in', ('dcr', 'cimd'))), name='mcp_clients_kind_check')],
            },
        ),
        migrations.CreateModel(
            name='McpRateWindow',
            fields=[
                ('pk', models.CompositePrimaryKey('bucket', 'window_start', blank=True, editable=False, primary_key=True, serialize=False)),
                ('bucket', models.TextField()),
                ('window_start', models.BigIntegerField()),
                ('count', models.IntegerField()),
                ('expires_at', models.BigIntegerField()),
            ],
            options={
                'db_table': 'mcp_rate_windows',
                'indexes': [models.Index(fields=['expires_at'], name='mcp_rate_windows_expiry_idx')],
            },
        ),
        migrations.CreateModel(
            name='McpAuthCode',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('code_hash', models.TextField(unique=True)),
                ('redirect_uri', models.TextField()),
                ('code_challenge', models.TextField()),
                ('scopes', models.JSONField()),
                ('resource', models.TextField()),
                ('auth_version_at_issue', models.IntegerField()),
                ('daily_cap_cents', models.IntegerField()),
                ('auto_approve_cents', models.IntegerField()),
                ('created_at', models.BigIntegerField()),
                ('expires_at', models.BigIntegerField()),
                ('used_at', models.BigIntegerField(null=True)),
                ('family_id', models.UUIDField(null=True)),
                ('user', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='authentication.user')),
                ('client', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='mcp_auth.mcpclient')),
            ],
            options={
                'db_table': 'mcp_auth_codes',
                'indexes': [models.Index(fields=['expires_at'], name='mcp_auth_codes_expiry_idx')],
            },
        ),
        migrations.CreateModel(
            name='McpToken',
            fields=[
                ('id', models.UUIDField(db_default=django.contrib.postgres.functions.RandomUUID(), primary_key=True, serialize=False)),
                ('kind', models.TextField()),
                ('token_hash', models.TextField(unique=True)),
                ('hint', models.TextField()),
                ('name', models.TextField(null=True)),
                ('scopes', models.JSONField()),
                ('resource', models.TextField()),
                ('auth_version_at_issue', models.IntegerField()),
                ('daily_cap_cents', models.IntegerField()),
                ('auto_approve_cents', models.IntegerField()),
                ('family_id', models.UUIDField()),
                ('created_at', models.BigIntegerField()),
                ('expires_at', models.BigIntegerField()),
                ('last_used_at', models.BigIntegerField(null=True)),
                ('rotated_at', models.BigIntegerField(null=True)),
                ('revoked_at', models.BigIntegerField(null=True)),
                ('client', models.ForeignKey(db_index=False, null=True, on_delete=django.db.models.deletion.CASCADE, to='mcp_auth.mcpclient')),
                ('user', models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, to='authentication.user')),
            ],
            options={
                'db_table': 'mcp_tokens',
                'indexes': [models.Index(fields=['user', 'kind'], name='mcp_tokens_user_kind_idx'), models.Index(fields=['family_id'], name='mcp_tokens_family_idx')],
                'constraints': [models.CheckConstraint(condition=models.Q(('kind__in', ('pat', 'access', 'refresh'))), name='mcp_tokens_kind_check'), models.CheckConstraint(condition=models.Q(models.Q(('client__isnull', True), ('kind', 'pat')), models.Q(models.Q(('kind', 'pat'), _negated=True), ('client__isnull', False)), _connector='OR'), name='mcp_tokens_client_check'), models.CheckConstraint(condition=models.Q(('auto_approve_cents__gte', 0), ('auto_approve_cents__lte', 100), ('daily_cap_cents__gte', 1)), name='mcp_tokens_caps_check')],
            },
        ),
    ]
