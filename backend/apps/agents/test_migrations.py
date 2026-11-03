"""agents 0003-0005 and generation 0011-0012: expand-only, granted to the runtime roles, with database-owned deletes."""
import uuid

from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase

from apps.generation.models import Generation
from . import services
from .models import (AgentChatAsset, AgentConversation, AgentConversationMessage, AgentGrant, AgentInboxMessage, AgentLlmUsage,
                     AgentRun, AgentRunEvent, AgentRunStep)

TABLES = ['agent_grants', 'agent_runs', 'agent_run_steps', 'agent_run_events', 'agent_inbox', 'agent_chat_assets', 'agent_llm_usage']
ROLES = ['goal4_green_preview_api', 'goal4_green_preview_worker']
HISTORY_ROLE = 'goal4_green_history_writer'
BEFORE = ('agents', '0002_railway_v2_agentconversationmessage')


def scalar(sql, params=()):
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchone()[0]


class AgentMigrationTests(TransactionTestCase):
    def leaves(self):
        return MigrationExecutor(connection).loader.graph.leaf_nodes()

    def test_the_runtime_roles_can_use_the_agent_tables(self):
        final = self.leaves()
        created = []
        try:
            MigrationExecutor(connection).migrate([node for node in final if node[0] != 'agents'] + [BEFORE])
            with connection.cursor() as cursor:
                for role in ROLES + [HISTORY_ROLE]:
                    cursor.execute(f'CREATE ROLE {role} NOLOGIN')
                    created.append(role)
            MigrationExecutor(connection).migrate(final)
            for role in ROLES:
                for table in TABLES:
                    for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'):
                        self.assertTrue(scalar('SELECT has_table_privilege(%s, %s, %s)', [role, table, privilege]),
                                        f'{role} lacks {privilege} on {table}')
            for table in TABLES:
                self.assertEqual((scalar('SELECT has_table_privilege(%s, %s, %s)', [HISTORY_ROLE, table, 'SELECT']),
                                  scalar('SELECT has_table_privilege(%s, %s, %s)', [HISTORY_ROLE, table, 'INSERT'])), (True, False), table)
            # No migration in the graph turns on row-level security, so the grants are the whole access rule.
            self.assertEqual(scalar('SELECT count(*) FROM pg_class WHERE relname = ANY(%s) AND relrowsecurity', [TABLES]), 0)
        finally:
            MigrationExecutor(connection).migrate(final)
            with connection.cursor() as cursor:
                for role in created:
                    cursor.execute(f'DROP OWNED BY {role}')
                    cursor.execute(f'DROP ROLE {role}')

    def test_conversations_are_backfilled_and_orphan_messages_removed_before_the_foreign_key(self):
        final = self.leaves()
        try:
            MigrationExecutor(connection).migrate([node for node in final if node[0] != 'agents'] + [BEFORE])
            owner, kept, orphan = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
            with connection.cursor() as cursor:
                cursor.execute("INSERT INTO agent_conversations (id, project_id, name, kind, agent_kind, created_by, created_at, updated_at) "
                               "VALUES (%s, %s, 'Owned', 'chat', 'image', %s, 1, 1), (%s, %s, 'Shared', 'chat', 'image', NULL, 1, 1)",
                               [kept, uuid.uuid4(), owner, orphan, uuid.uuid4()])
                cursor.execute("INSERT INTO agent_conversation_messages (id, conversation_id, role, content, created_at) "
                               "VALUES (%s, %s, 'user', 'kept', 1), (%s, %s, 'user', 'orphan', 1)", [uuid.uuid4(), kept, uuid.uuid4(), uuid.uuid4()])
            MigrationExecutor(connection).migrate([node for node in final if node[0] != 'agents'] + [('agents', '0004_message_conversation_fk')])
            with connection.cursor() as cursor:
                cursor.execute('SELECT id, user_id, settings FROM agent_conversations ORDER BY name')
                self.assertEqual(cursor.fetchall(), [(kept, owner, '{}'), (orphan, None, '{}')])
                cursor.execute('SELECT content FROM agent_conversation_messages')
                self.assertEqual(cursor.fetchall(), [('kept',)])
                cursor.execute("SELECT convalidated, confdeltype FROM pg_constraint WHERE conname = 'agent_conversation_messages_conversation_id_fkey'")
                self.assertEqual(cursor.fetchone(), (False, 'c'))
            with self.assertRaises(IntegrityError), connection.cursor() as cursor:
                cursor.execute("INSERT INTO agent_conversation_messages (id, conversation_id, role, content, created_at) "
                               "VALUES (%s, %s, 'user', 'x', 1)", [uuid.uuid4(), uuid.uuid4()])
            # Reversible: back past 0003 and forward again.
            MigrationExecutor(connection).migrate([node for node in final if node[0] != 'agents'] + [BEFORE])
            MigrationExecutor(connection).migrate(final)
        finally:
            MigrationExecutor(connection).migrate(final)

    def test_the_generation_index_is_partial_and_built_concurrently(self):
        loader = MigrationExecutor(connection).loader
        self.assertFalse(loader.get_migration('generation', '0012_generation_agent_run_index').atomic)
        definition = scalar("SELECT indexdef FROM pg_indexes WHERE indexname = 'generations_agent_run_idx'")
        self.assertIn('(agent_run_id)', definition)
        self.assertIn('WHERE (agent_run_id IS NOT NULL)', definition)
        self.assertTrue(scalar("SELECT indisvalid FROM pg_index WHERE indexrelid = 'generations_agent_run_idx'::regclass"))


class AgentDeletionTests(TestCase):
    def setUp(self):
        self.user = uuid.uuid4()
        self.grant = AgentGrant.objects.create(user_id=self.user, scopes=['veevee.read'], daily_cap_cents=1000, auto_approve_cents=25,
                                               auth_version_at_issue=0, created_at=1)
        self.conversation = services.create_conversation(uuid.uuid4(), 'image', 'Foxes', self.user)

    def run_row(self, conversation_id=None, status='running'):
        return AgentRun.objects.create(conversation_id=conversation_id or self.conversation['id'], user_id=self.user, grant_id=self.grant.id,
                                       status=status, model='gemini-3.8-flash', created_at=1, updated_at=1)

    def test_deleting_a_conversation_cascades_and_keeps_the_usage_ledger(self):
        conversation_id = self.conversation['id']
        self.assertEqual(AgentConversation.objects.get(pk=conversation_id).user_id, self.user)
        run = self.run_row()
        AgentConversationMessage.objects.create(conversation_id=conversation_id, role='user', content='hi', created_at=1)
        AgentRunStep.objects.create(run_id=run.id, step_index=0, kind='llm', input_hash='h', started_at=1)
        AgentRunEvent.objects.create(run_id=run.id, seq=0, kind='status', created_at=1)
        AgentInboxMessage.objects.create(conversation_id=conversation_id, run_id=run.id, user_id=self.user, content='also blue', created_at=1)
        AgentChatAsset.objects.create(conversation_id=conversation_id, asset_id=uuid.uuid4(), source='upload', kind='image', created_at=1)
        usage = AgentLlmUsage.objects.create(user_id=self.user, grant_id=self.grant.id, conversation_id=conversation_id, run_id=run.id,
                                             step_index=0, model='gemini-3.8-flash', purpose='step', prompt_tokens=1, cached_tokens=0,
                                             output_tokens=1, thoughts_tokens=0, tool_prompt_tokens=0, total_tokens=2, cost_microcents=5,
                                             created_at=1)
        generation = Generation.objects.create(id=uuid.uuid4(), kind='image', status='queued', prompt='fox', model='Nano Banana 2.1',
                                               user_id=self.user, created_at=1, updated_at=1, created_via='agent', agent_run_id=run.id)
        services.delete_conversation(conversation_id)
        for model in (AgentConversation, AgentConversationMessage, AgentRun, AgentRunStep, AgentRunEvent, AgentInboxMessage, AgentChatAsset):
            self.assertFalse(model.objects.exists(), model.__name__)
        usage.refresh_from_db()
        self.assertEqual((usage.conversation_id, usage.run_id, usage.cost_microcents, usage.grant_id), (None, None, 5, self.grant.id))
        self.assertTrue(AgentGrant.objects.filter(pk=self.grant.id).exists())
        # Library items are the artist's: they outlive the chat that made them.
        self.assertEqual(Generation.objects.get(pk=generation.id).agent_run_id, run.id)

    def test_one_active_run_per_conversation_and_grants_with_runs_are_kept(self):
        self.run_row(status='completed')
        self.run_row(status='queued')
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.run_row(status='waiting_approval')
        self.run_row(status='cancelled')
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.run_row(conversation_id=uuid.uuid4())
        with self.assertRaises(IntegrityError), transaction.atomic():
            AgentGrant.objects.filter(pk=self.grant.id).delete()
        with self.assertRaises(IntegrityError), transaction.atomic():
            AgentGrant.objects.create(user_id=self.user, scopes=[], daily_cap_cents=1, auto_approve_cents=0, auth_version_at_issue=0,
                                      created_at=2)
        AgentGrant.objects.filter(pk=self.grant.id).update(revoked_at=2)
        AgentGrant.objects.create(user_id=self.user, scopes=[], daily_cap_cents=1, auto_approve_cents=0, auth_version_at_issue=0, created_at=3)
        with self.assertRaises(IntegrityError), transaction.atomic():
            AgentRunStep.objects.create(run_id=uuid.uuid4(), step_index=0, kind='llm', input_hash='h', started_at=1)
