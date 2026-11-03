from django.contrib.postgres.functions import RandomUUID
from apps.common.indexes import PostgreSQLIndex
from django.db import models
from django.db.models import Q


class AgentConversation(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    project_id = models.UUIDField()
    name = models.TextField()
    kind = models.TextField(default='chat', db_default='chat')
    agent_kind = models.TextField(null=True)
    created_by = models.UUIDField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()
    # The Gemini agent (agents 0003, expand only): the owner, where outputs land when the model names no location,
    # per-chat settings, the run state the tab shows, a rolling summary and when the last run started. user_id is
    # backfilled from created_by; it becomes NOT NULL in a later contract migration.
    user_id = models.UUIDField(null=True)
    default_project_id = models.UUIDField(null=True)
    default_folder_id = models.UUIDField(null=True)
    settings = models.JSONField(default=dict, db_default={})
    status = models.TextField(null=True)
    summary = models.TextField(null=True)
    last_run_at = models.BigIntegerField(null=True)

    class Meta:
        managed = True
        db_table = 'agent_conversations'
        indexes = [
            PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), name='agent_conversations_project_id_idx'),
            PostgreSQLIndex(models.F('project_id').asc(nulls_last=True), models.F('agent_kind').asc(nulls_last=True), name='agent_conversations_project_kind_idx'),
        ]


class AgentConversationMessage(models.Model):
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    # A database foreign key to agent_conversations, ON DELETE CASCADE, added NOT VALID (agents 0004).
    conversation_id = models.UUIDField()
    role = models.TextField()
    content = models.TextField()
    tool_trace = models.JSONField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_conversation_messages'
        indexes = [
            PostgreSQLIndex(models.F('conversation_id').asc(nulls_last=True), name='agent_conversation_messages_conversation_id_idx'),
        ]


# The Gemini agent's durable state (agents 0005). Each table keeps plain UUID columns, like the rest of the schema;
# the database owns the foreign keys: deleting a conversation cascades to its runs, steps, events, inbox and chat
# assets, and sets the usage ledger's conversation and run ids to NULL so the ledger keeps every row.

ACTIVE_RUN_STATUSES = ('queued', 'running', 'waiting_approval', 'waiting_jobs', 'paused_limit')
TERMINAL_RUN_STATUSES = ('completed', 'failed', 'cancelled')


class AgentGrant(models.Model):
    """The Agents tab's authority to act for one user: scopes and caps like an MCP grant, but held in-process.

    Its id is the principal's ``token_id``: spend, rates and audit key on it exactly as on an MCP grant. No secret
    exists, so a grant can never authenticate over HTTP. ``auth_version_at_issue`` ends it when the user's password,
    role or status changes; an admin revokes it with ``revoked_at``. One live grant per user.
    """
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user_id = models.UUIDField()
    scopes = models.JSONField()
    daily_cap_cents = models.IntegerField()
    auto_approve_cents = models.IntegerField()
    auth_version_at_issue = models.IntegerField()
    created_at = models.BigIntegerField()
    revoked_at = models.BigIntegerField(null=True)
    revoked_by = models.UUIDField(null=True)

    class Meta:
        managed = True
        db_table = 'agent_grants'
        constraints = [models.UniqueConstraint(fields=['user_id'], condition=Q(revoked_at__isnull=True), name='agent_grants_live_user_uniq')]


class AgentRun(models.Model):
    """One agent run in a conversation: queued, running, waiting (approval, jobs, a limit), then terminal."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    conversation_id = models.UUIDField()
    user_id = models.UUIDField()
    grant_id = models.UUIDField()
    status = models.TextField(default='queued', db_default='queued')
    model = models.TextField()
    step_count = models.IntegerField(default=0, db_default=0)
    cost_cents = models.IntegerField(default=0, db_default=0)          # paid tool estimates; LLM cost is in agent_llm_usage
    pause_reason = models.TextField(null=True)
    resume_after = models.BigIntegerField(null=True)
    error = models.JSONField(null=True)
    cancel_requested_at = models.BigIntegerField(null=True)
    cancel_jobs = models.BooleanField(default=False, db_default=False)
    last_heartbeat_at = models.BigIntegerField(null=True)
    started_at = models.BigIntegerField(null=True)
    finished_at = models.BigIntegerField(null=True)
    created_at = models.BigIntegerField()
    updated_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_runs'
        indexes = [
            models.Index(fields=['conversation_id', '-created_at'], name='agent_runs_conversation_idx'),
            models.Index(fields=['user_id', 'status'], name='agent_runs_user_status_idx'),
            models.Index(fields=['status', 'updated_at'], condition=Q(status__in=ACTIVE_RUN_STATUSES), name='agent_runs_active_idx'),
        ]
        constraints = [models.UniqueConstraint(fields=['conversation_id'], condition=Q(status__in=ACTIVE_RUN_STATUSES),
                                               name='agent_runs_one_active_uniq')]


class AgentRunStep(models.Model):
    """The journal: one LLM call or tool call per step. A tool step's idempotency key is ``<run id>:<step index>``,
    so replaying it after a crash returns the existing receipt instead of billing twice."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    run_id = models.UUIDField()
    step_index = models.IntegerField()
    kind = models.TextField()                                          # 'llm' or 'tool'
    tool_name = models.TextField(null=True)
    input_hash = models.TextField()
    idempotency_key = models.TextField(null=True)
    status = models.TextField(default='started', db_default='started')
    outcome = models.TextField(null=True)
    result = models.JSONField(null=True)
    cost_cents = models.IntegerField(default=0, db_default=0)
    started_at = models.BigIntegerField()
    finished_at = models.BigIntegerField(null=True)

    class Meta:
        managed = True
        db_table = 'agent_run_steps'
        constraints = [models.UniqueConstraint(fields=['run_id', 'step_index'], name='agent_run_steps_run_step_uniq')]


class AgentRunEvent(models.Model):
    """What the tab polls while a run is active, in ``seq`` order per run."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    run_id = models.UUIDField()
    seq = models.IntegerField()
    kind = models.TextField()
    payload = models.JSONField(default=dict, db_default={})
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_run_events'
        constraints = [models.UniqueConstraint(fields=['run_id', 'seq'], name='agent_run_events_run_seq_uniq')]


class AgentInboxMessage(models.Model):
    """A user message sent while a run is active; the run delivers it at its next step boundary."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    conversation_id = models.UUIDField()
    run_id = models.UUIDField(null=True)
    user_id = models.UUIDField()
    content = models.TextField()
    attachments = models.JSONField(default=list, db_default=[])
    created_at = models.BigIntegerField()
    delivered_at = models.BigIntegerField(null=True)
    delivered_step = models.IntegerField(null=True)

    class Meta:
        managed = True
        db_table = 'agent_inbox'
        indexes = [models.Index(fields=['conversation_id', 'created_at'], name='agent_inbox_conversation_idx'),
                   models.Index(fields=['run_id', 'created_at'], condition=Q(delivered_at__isnull=True), name='agent_inbox_pending_idx')]


class AgentChatAsset(models.Model):
    """A library file the conversation can use by id: an attachment (an upload id) or a run's output (a generation id)."""
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    conversation_id = models.UUIDField()
    asset_id = models.UUIDField()
    source = models.TextField()                                        # 'attachment' or 'output'
    kind = models.TextField()                                          # 'image', 'video', 'audio' or 'document'
    run_id = models.UUIDField(null=True)
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_chat_assets'
        constraints = [models.UniqueConstraint(fields=['conversation_id', 'asset_id'], name='agent_chat_assets_conversation_asset_uniq')]


class AgentLlmUsage(models.Model):
    """The usage ledger: one row per agent LLM call, from Gemini's ``usageMetadata``, priced at the call's time.

    ``cost_microcents`` is millionths of a cent. Rows outlive their conversation: deleting it sets the conversation
    and run ids to NULL.
    """
    id = models.UUIDField(primary_key=True, db_default=RandomUUID())
    user_id = models.UUIDField()
    grant_id = models.UUIDField(null=True)
    conversation_id = models.UUIDField(null=True)
    run_id = models.UUIDField(null=True)
    step_index = models.IntegerField(null=True)
    model = models.TextField()
    purpose = models.TextField()
    prompt_tokens = models.IntegerField()
    cached_tokens = models.IntegerField()
    output_tokens = models.IntegerField()
    thoughts_tokens = models.IntegerField()
    tool_prompt_tokens = models.IntegerField()
    total_tokens = models.IntegerField()
    cost_microcents = models.BigIntegerField()
    created_at = models.BigIntegerField()

    class Meta:
        managed = True
        db_table = 'agent_llm_usage'
        indexes = [models.Index(fields=['user_id', 'created_at'], name='agent_llm_usage_user_idx'),
                   models.Index(fields=['created_at'], name='agent_llm_usage_created_idx'),
                   models.Index(fields=['conversation_id'], name='agent_llm_usage_conv_idx'),
                   models.Index(fields=['run_id'], name='agent_llm_usage_run_idx')]
