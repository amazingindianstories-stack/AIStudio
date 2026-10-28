"""Agent (MCP) identity: OAuth clients, opaque hashed tokens, authorization codes and rate windows."""
from django.contrib.postgres.functions import RandomUUID
from django.db import models

from apps.authentication.models import User


class McpClient(models.Model):
    """An OAuth client: registered dynamically (DCR) or identified by its metadata document URL (CIMD)."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    client_id = models.TextField(unique=True)
    kind = models.TextField()  # 'dcr' or 'cimd'
    client_name = models.TextField()
    client_uri = models.TextField(null=True)
    logo_uri = models.TextField(null=True)
    redirect_uris = models.JSONField()
    created_at = models.BigIntegerField()
    fetched_at = models.BigIntegerField(null=True)            # CIMD document cache time
    last_authorized_at = models.BigIntegerField(null=True)    # unused DCR clients are purged after a day

    class Meta:
        db_table = 'mcp_clients'
        constraints = [models.CheckConstraint(condition=models.Q(kind__in=('dcr', 'cimd')), name='mcp_clients_kind_check')]


class McpToken(models.Model):
    """One opaque bearer secret, stored only as its SHA-256.

    ``family_id`` is the grant: a personal access token is its own family; an OAuth connection's access and
    refresh tokens share one family across refresh rotation. Caps, spend and revocation follow the family.
    """
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user = models.ForeignKey(User, on_delete=models.CASCADE, db_index=False)
    client = models.ForeignKey(McpClient, on_delete=models.CASCADE, null=True, db_index=False)
    kind = models.TextField()  # 'pat', 'access' or 'refresh'
    token_hash = models.TextField(unique=True)
    hint = models.TextField()
    name = models.TextField(null=True)
    scopes = models.JSONField()
    resource = models.TextField()
    auth_version_at_issue = models.IntegerField()
    daily_cap_cents = models.IntegerField()
    auto_approve_cents = models.IntegerField()
    family_id = models.UUIDField()
    created_at = models.BigIntegerField()
    expires_at = models.BigIntegerField()
    last_used_at = models.BigIntegerField(null=True)
    rotated_at = models.BigIntegerField(null=True)
    revoked_at = models.BigIntegerField(null=True)

    class Meta:
        db_table = 'mcp_tokens'
        indexes = [models.Index(fields=['user', 'kind'], name='mcp_tokens_user_kind_idx'),
                   models.Index(fields=['family_id'], name='mcp_tokens_family_idx')]
        constraints = [
            models.CheckConstraint(condition=models.Q(kind__in=('pat', 'access', 'refresh')), name='mcp_tokens_kind_check'),
            models.CheckConstraint(condition=models.Q(kind='pat', client__isnull=True) | (~models.Q(kind='pat') & models.Q(client__isnull=False)),
                                   name='mcp_tokens_client_check'),
            models.CheckConstraint(condition=models.Q(daily_cap_cents__gte=1, auto_approve_cents__gte=0, auto_approve_cents__lte=100),
                                   name='mcp_tokens_caps_check'),
        ]


class McpAuthCode(models.Model):
    """A single-use authorization code bound to its client, redirect URI, PKCE challenge and consent."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    code_hash = models.TextField(unique=True)
    client = models.ForeignKey(McpClient, on_delete=models.CASCADE, db_index=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, db_index=False)
    redirect_uri = models.TextField()
    code_challenge = models.TextField()
    scopes = models.JSONField()
    resource = models.TextField()
    auth_version_at_issue = models.IntegerField()
    daily_cap_cents = models.IntegerField()
    auto_approve_cents = models.IntegerField()
    created_at = models.BigIntegerField()
    expires_at = models.BigIntegerField()
    used_at = models.BigIntegerField(null=True)
    family_id = models.UUIDField(null=True)  # the grant it was exchanged for; a replay revokes it

    class Meta:
        db_table = 'mcp_auth_codes'
        indexes = [models.Index(fields=['expires_at'], name='mcp_auth_codes_expiry_idx')]


class McpRateWindow(models.Model):
    """A fixed-window counter or a hold slot (no Redis; the same upsert pattern as naming counters)."""
    pk = models.CompositePrimaryKey('bucket', 'window_start')
    bucket = models.TextField()
    window_start = models.BigIntegerField()
    count = models.IntegerField()
    expires_at = models.BigIntegerField()

    class Meta:
        db_table = 'mcp_rate_windows'
        indexes = [models.Index(fields=['expires_at'], name='mcp_rate_windows_expiry_idx')]
