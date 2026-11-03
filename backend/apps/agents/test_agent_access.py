"""The Agents tab's principal: agent grants, their revocation, the tools they reach and the budget they share with MCP."""
import asyncio
import uuid
from unittest.mock import patch

from jsonschema import Draft202012Validator

from apps.authentication.models import User
from apps.generation.models import Generation
from apps.mcp import errors, server
from apps.mcp.registry import AGENT_TOOLS, REGISTRY, visible
from apps.mcp.tests.support import McpCase, initialize_body
from apps.mcp.tests.test_paid_tools import mid_minute
from apps.mcp.tests.test_results import StorageMixin
from apps.mcp.tools import admin as admin_tool
from apps.mcp_auth import controls, policy, tokens
from apps.mcp_auth.principal import AuthenticationError, authenticate_bearer
from .grants import AGENT_SCOPES, CLIENT_NAME, AgentGrantInvalid, agent_principal, ensure_grant, recheck, revoke_grant
from .models import AgentGrant

PROTOCOL = '2025-11-25'


def dispatch(principal, name, arguments=None, **options):
    return asyncio.run(server.dispatch(principal, name, arguments or {}, request_id='agent-step', protocol_version=PROTOCOL, **options))


class AgentGrantTests(McpCase):
    def test_one_live_grant_per_user_reissued_after_an_auth_change(self):
        grant = ensure_grant(self.admin.id)
        self.assertEqual(ensure_grant(self.admin.id).id, grant.id)
        self.assertEqual((grant.scopes, grant.daily_cap_cents, grant.auto_approve_cents, grant.auth_version_at_issue, grant.revoked_at),
                         (list(AGENT_SCOPES), policy.TOKEN_DAILY_CAP_DEFAULT, policy.AUTO_APPROVE_DEFAULT, 0, None))
        User.objects.filter(pk=self.admin.id).update(auth_version=1)                    # a password, role or status change
        with self.assertRaises(AgentGrantInvalid):
            agent_principal(grant.id)
        renewed = ensure_grant(self.admin.id)
        self.assertNotEqual(renewed.id, grant.id)
        self.assertIsNotNone(AgentGrant.objects.get(pk=grant.id).revoked_at)
        self.assertEqual((renewed.auth_version_at_issue, AgentGrant.objects.filter(user_id=self.admin.id, revoked_at__isnull=True).count()), (1, 1))
        User.objects.filter(pk=self.user.id).update(is_active=False)
        with self.assertRaises(AgentGrantInvalid):
            ensure_grant(self.user.id)
        with self.assertRaises(AgentGrantInvalid):
            ensure_grant(uuid.uuid4())

    def test_the_principal_is_an_agent_grant_with_the_users_agent_limits(self):
        policy.set_enabled(self.user.id, False, 2)                                      # the MCP token opt-in does not apply
        grant = ensure_grant(self.user.id)
        principal = agent_principal(grant.id)
        limits = policy.user_limits(self.user.id)
        self.assertEqual((principal.kind, principal.token_id, principal.token_row_id, principal.client_id, principal.client_name),
                         ('agent', grant.id, grant.id, None, CLIENT_NAME))
        self.assertEqual(principal.scopes, frozenset(AGENT_SCOPES))
        self.assertEqual((principal.caps.token_daily_cap_cents, principal.caps.auto_approve_cents, principal.caps.user_daily_cap_cents,
                          principal.caps.active_jobs), (grant.daily_cap_cents, grant.auto_approve_cents, limits['dailyCapCents'], limits['activeJobs']))
        self.assertEqual(principal.origin_fields(), {'created_via': 'agent', 'mcp_token_id': grant.id, 'mcp_client_id': None})
        self.assertEqual(authenticate_bearer(self.token(self.admin)).origin_fields()['created_via'], 'mcp')
        # Admin users' grants hold no admin scope.
        self.assertNotIn(policy.ADMIN_SCOPE, agent_principal(ensure_grant(self.admin.id).id).scopes)

    def test_recheck_ends_a_run_on_revocation_auth_change_or_deactivation(self):
        principal = agent_principal(ensure_grant(self.user.id).id)
        self.assertEqual(recheck(principal), principal)
        self.assertEqual(revoke_grant(self.user.id, actor_id=self.admin.id), 1)
        self.assertEqual(AgentGrant.objects.get(pk=principal.token_id).revoked_by, self.admin.id)
        with self.assertRaises(AgentGrantInvalid):
            recheck(principal)
        self.assertEqual(revoke_grant(self.user.id), 0)
        principal = agent_principal(ensure_grant(self.user.id).id)
        User.objects.filter(pk=self.user.id).update(auth_version=4)
        with self.assertRaises(AgentGrantInvalid):
            recheck(principal)
        principal = agent_principal(ensure_grant(self.user.id).id)
        User.objects.filter(pk=self.user.id).update(is_active=False)
        with self.assertRaises(AgentGrantInvalid):
            recheck(principal)
        with self.assertRaises(AgentGrantInvalid):
            recheck(authenticate_bearer(self.token(self.admin)))                        # not an agent principal

    def test_revoking_all_agent_access_ends_the_grant_and_reports_tokens_only(self):
        raw = self.token()
        principal = agent_principal(ensure_grant(self.user.id).id)
        self.assertEqual(tokens.revoke_all_for_user(self.user.id), 1)
        with self.assertRaises(AgentGrantInvalid):
            recheck(principal)
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(raw)

    def test_a_grant_never_authenticates_over_http(self):
        grant = ensure_grant(self.user.id)
        for value in (str(grant.id), f'Bearer {grant.id}', grant.id.hex):
            with self.assertRaises(AuthenticationError):
                authenticate_bearer(value)
        self.assertEqual(self.post(initialize_body(), {'authorization': f'Bearer {grant.id}'}).status_code, 401)


class AgentToolTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        clock = patch('apps.mcp_auth.controls.now_ms', return_value=mid_minute())
        clock.start()
        self.addCleanup(clock.stop)

    def test_an_agent_sees_and_reaches_only_the_agents_tab_tools(self):
        principal = agent_principal(ensure_grant(self.admin.id).id)
        self.assertEqual({spec.name for spec in visible(principal)}, set(AGENT_TOOLS))
        self.assertLessEqual(set(AGENT_TOOLS), set(REGISTRY))
        excluded = sorted(set(REGISTRY) - set(AGENT_TOOLS))
        self.assertIn('move_to_folder', excluded)
        self.assertTrue({name for name in REGISTRY if name.startswith('admin_')} <= set(excluded))
        for name in excluded:
            with self.assertRaises(server.UnknownTool):
                dispatch(principal, name, {'userId': str(self.user.id)})
        # The same admin's MCP token still reaches them.
        mcp = authenticate_bearer(self.token(self.admin, scopes=('veevee.read', 'veevee.organize', 'veevee.admin')))
        self.assertIn('move_to_folder', {spec.name for spec in visible(mcp)})
        self.assertFalse(dispatch(mcp, 'admin_system_status').response.is_error)

    def test_get_account_describes_the_agent_grant(self):
        principal = agent_principal(ensure_grant(self.user.id).id)
        done = dispatch(principal, 'get_account')
        self.assertIsNone(done.error)
        body = done.result.structured
        self.assertEqual(body['token'], {'name': CLIENT_NAME, 'kind': 'agent', 'client': CLIENT_NAME,
                                         'scopes': sorted(AGENT_SCOPES), 'expiresAt': None})
        self.assertEqual(list(Draft202012Validator(REGISTRY['get_account'].output_schema).iter_errors(body)), [])

    def test_agent_jobs_carry_the_agent_origin_and_share_the_mcp_budget(self):
        principal = agent_principal(ensure_grant(self.user.id).id)
        done = dispatch(principal, 'generate_image', {'prompt': 'red fox in snow', 'wait': False}, tags={'runId': 'run-1', 'stepIndex': 0})
        self.assertIsNone(done.error, done.error and done.error.payload())
        row = Generation.objects.get(pk=done.result.structured['generation']['id'])
        self.assertEqual((row.created_via, row.mcp_token_id, row.mcp_client_id, row.user_id), ('agent', principal.token_id, None, self.user.id))
        self.assertEqual(done.result.structured['generation']['createdVia'], 'agent')
        self.assertEqual(dispatch(principal, 'get_generation', {'id': str(row.id)}).result.structured['generation']['createdVia'], 'agent')
        mcp = authenticate_bearer(self.token())
        mcp_row = Generation.objects.create(id=uuid.uuid4(), kind='image', status='running', prompt='fixture', model='Nano Banana 2.1',
                                            user_id=self.user.id, cost_cents=10, created_at=row.created_at, updated_at=row.created_at,
                                            **mcp.origin_fields())
        Generation.objects.create(id=uuid.uuid4(), kind='image', status='running', prompt='fixture', model='Nano Banana 2.1',
                                  user_id=self.user.id, cost_cents=100, created_at=row.created_at, updated_at=row.created_at)   # web
        now = row.created_at + 1
        self.assertEqual(controls.spent_cents(self.user.id, now=now), row.cost_cents + 10)
        self.assertEqual(controls.spent_cents(self.user.id, token_id=principal.token_id, now=now), row.cost_cents)
        self.assertEqual(controls.spent_cents(self.user.id, token_id=mcp.token_id, now=now), mcp_row.cost_cents)
        self.assertEqual(controls.active_jobs(self.user.id), 2)
        account = dispatch(principal, 'get_account').result.structured
        self.assertEqual((account['spend']['tokenTodayCents'], account['activeJobs']), (row.cost_cents, 2))
        # The admin spend report counts agent jobs with MCP's and names the Agents tab as their client.
        admin = authenticate_bearer(self.token(self.admin, scopes=('veevee.read', 'veevee.admin')))
        with patch.object(admin_tool, 'now_ms', return_value=now):
            report = dispatch(admin, 'admin_spend_report', {'days': 1, 'groupBy': 'client'}).result.structured
        rows = {item['key']: item for item in report['rows']}
        self.assertEqual((rows['agents-tab']['label'], rows['agents-tab']['mcpCount'], rows['agents-tab']['mcpBookedCents']),
                         ('Agents tab', 1, row.cost_cents))
        self.assertEqual((report['totals']['mcpCount'], report['totals']['mcpBookedCents']), (2, row.cost_cents + 10))
        self.assertEqual(rows['web']['mcpCount'], 0)
        status = dispatch(admin, 'admin_system_status').result.structured
        self.assertEqual(status['agents']['activeJobs'], 2)

    def test_agent_calls_are_admitted_like_mcp_calls(self):
        principal = agent_principal(ensure_grant(self.user.id).id)
        refused = dispatch(principal, 'create_folder', {'name': 'Paused'}, maintenance=True)
        self.assertEqual(refused.error.code, errors.MAINTENANCE)
        with patch.dict(policy.RATE_LIMITS, calls=(1, 60)):
            self.assertIsNone(dispatch(principal, 'list_models').error)
            self.assertEqual(dispatch(principal, 'list_models').error.code, errors.RATE_LIMITED)
