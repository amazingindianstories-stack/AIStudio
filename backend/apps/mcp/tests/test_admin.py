"""Milestone 9: admin tools (spend report, provider errors, system status, emergency revoke)."""
import json
import uuid
from unittest.mock import patch

from apps.admin_dashboard import status
from apps.admin_dashboard.models import AppSetting
from apps.common.leases import now_ms
from apps.common.models import ActivityLog
from apps.generation.availability import availability
from apps.generation.models import Generation
from apps.mcp import errors, runtime
from apps.mcp.registry import REGISTRY
from apps.mcp.shapes import iso
from apps.mcp.tools import admin as tool
from apps.mcp_auth import controls, tokens
from apps.mcp_auth.models import McpClient, McpToken
from .support import ERAS, McpCase, initialize_body

ADMIN_TOOLS = ('admin_spend_report', 'admin_provider_errors', 'admin_system_status', 'admin_revoke_mcp_tokens')
DAY = 86400000


class AdminToolTests(McpCase):
    def setUp(self):
        super().setUp()
        self.raw = self.token(self.admin, scopes=('veevee.read', 'veevee.admin'))
        self.now = now_ms()

    def generation(self, age_ms=60000, **values):
        created = self.now - age_ms
        fields = dict(id=uuid.uuid4(), kind='image', status='succeeded', prompt='fixture', model='Nano Banana 2.1',
                      aspect_ratio='1:1', user_id=self.user.id, created_at=created, updated_at=created + 5,
                      completed_at=created + 5)
        return Generation.objects.create(**{**fields, **values})

    def client_row(self, name='Claude'):
        return McpClient.objects.create(client_id='vvc_' + uuid.uuid4().hex, kind='dcr', client_name=name,
                                        redirect_uris=['http://127.0.0.1/cb'], created_at=1)

    def test_admin_tools_need_the_scope_and_the_admin_role_on_every_call(self):
        for era in ERAS:
            async def find(client):
                return {found.name: found for found in (await client.list_tools()).tools}
            listed = self.with_client(self.raw, era, find)
            for name in ADMIN_TOOLS:
                hints = listed[name].annotations
                expected = (False, True, True, False) if name == 'admin_revoke_mcp_tokens' else (True, False, True, False)
                self.assertEqual((hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint, hints.open_world_hint),
                                 expected, name)
                self.assertTrue(listed[name].description.startswith('Admins only'))
        self.assertFalse(set(ADMIN_TOOLS) & set(self.tool_names(self.token(self.admin, scopes=('veevee.read',)))))
        # A token minted while the user was an admin loses the admin scope once the role is gone (checked per request).
        demoted = self.token(self.user, scopes=('veevee.read', 'veevee.admin'))
        self.assertFalse(set(ADMIN_TOOLS) & set(self.tool_names(demoted)))
        for name in ADMIN_TOOLS:
            refused = self.call(demoted, name, {'userId': str(self.admin.id)} if name == 'admin_revoke_mcp_tokens' else {})
            self.assert_tool_error(refused, errors.INSUFFICIENT_SCOPE)
        self.assertNotIn('veevee.admin', self.call(demoted, 'get_account').structured_content['token']['scopes'])
        scoped = self.call(self.token(self.admin, scopes=('veevee.read',)), 'admin_system_status')
        self.assert_tool_error(scoped, errors.INSUFFICIENT_SCOPE)
        self.assertFalse(McpToken.objects.filter(revoked_at__isnull=False).exists())

    def test_spend_report_groups_by_model_user_and_client_with_sql_totals(self):
        claude = self.client_row()
        pat = McpToken.objects.get(user=self.admin).family_id
        self.generation(cost_cents=100, cost_basis='reconciled')                                    # web
        self.generation(cost_cents=40, created_via='mcp', mcp_token_id=pat)                         # PAT, estimated
        self.generation(cost_cents=60, cost_basis='reconciled', created_via='mcp', mcp_client_id=claude.id,
                        model='Seedance 2.5', kind='video', user_id=self.admin.id)
        self.generation(cost_cents=500, status='running', created_via='mcp', mcp_client_id=claude.id, model='Seedance 2.5',
                        kind='video')
        self.generation(cost_cents=30, status='failed')
        self.generation(age_ms=8 * DAY, cost_cents=999)                                              # outside 7 days
        totals = {'count': 5, 'costCents': 200, 'reconciledCostCents': 160, 'estimatedCostCents': 40, 'activeCount': 1,
                  'mcpCount': 3, 'mcpCostCents': 100, 'mcpBookedCents': 600}
        clock = patch.object(tool, 'now_ms', return_value=self.now)
        clock.start()
        self.addCleanup(clock.stop)
        for era in ERAS:
            result = self.call(self.raw, 'admin_spend_report', {}, era)
            self.assert_structured(result, tool.SPEND_RESULT)
            body = result.structured_content
            self.assertEqual((body['days'], body['groupBy'], body['totals'], body['groupCount'], body['truncated']),
                             (7, 'model', totals, 2, False))
            self.assertEqual(body['since'], iso(self.now - 7 * DAY))
            self.assertEqual(body['rows'], [
                {'key': 'Nano Banana 2.1', 'label': 'Nano Banana 2.1', 'count': 3, 'costCents': 140, 'reconciledCostCents': 100,
                 'estimatedCostCents': 40, 'activeCount': 0, 'mcpCount': 1, 'mcpCostCents': 40, 'mcpBookedCents': 40},
                {'key': 'Seedance 2.5', 'label': 'Seedance 2.5', 'count': 2, 'costCents': 60, 'reconciledCostCents': 60,
                 'estimatedCostCents': 0, 'activeCount': 1, 'mcpCount': 2, 'mcpCostCents': 60, 'mcpBookedCents': 560}])
            self.assertIn('$2.00', result.content[0].text)
        users = self.call(self.raw, 'admin_spend_report', {'groupBy': 'user'}).structured_content
        self.assertEqual([(row['key'], row['label'], row['count'], row['costCents']) for row in users['rows']],
                         [(str(self.user.id), 'Artist', 4, 140), (str(self.admin.id), 'Admin', 1, 60)])
        clients = self.call(self.raw, 'admin_spend_report', {'groupBy': 'client'}).structured_content
        self.assertEqual([(row['key'], row['label'], row['count'], row['costCents'], row['mcpCount']) for row in clients['rows']],
                         [('web', 'Web app', 2, 100, 0), (str(claude.id), 'Claude', 2, 60, 2),
                          ('personal-access-token', 'Personal access tokens', 1, 40, 1)])
        wide = self.call(self.raw, 'admin_spend_report', {'days': 90}).structured_content
        self.assertEqual((wide['totals']['count'], wide['totals']['costCents']), (6, 1199))
        with patch.object(tool, 'MAX_GROUPS', 1):
            capped = self.call(self.raw, 'admin_spend_report', {'groupBy': 'user'}).structured_content
        self.assertEqual((len(capped['rows']), capped['groupCount'], capped['truncated'], capped['totals']), (1, 2, True, totals))
        for arguments in ({'days': 0}, {'days': 91}, {'groupBy': 'token'}, {'limit': 5}):
            self.assert_tool_error(self.call(self.raw, 'admin_spend_report', arguments), errors.INVALID_INPUT)
        self.assertFalse(ActivityLog.objects.filter(action='mcp_tool_call').exists())     # reads are not audited

    def test_spend_report_booked_cents_agree_with_get_account(self):
        # The self-test gap: a cancelled Seedance draft whose billing is unconfirmed counts against the agent caps (and in
        # get_account) but not in the succeeded-only cost columns. mcpBookedCents sums exactly what get_account sums.
        pat = McpToken.objects.get(user=self.admin).family_id
        mcp = dict(created_via='mcp', mcp_token_id=pat)
        self.generation(cost_cents=25, cost_basis='reconciled', **mcp)
        self.generation(cost_cents=14, status='cancelled', cost_basis='cancelled_billing_unconfirmed', model='Seedance 2.5',
                        kind='video', duration=4, resolution='480p', **mcp)
        self.generation(cost_cents=30, status='cancelled', cost_basis='cancelled_before_submission', **mcp)   # free
        self.generation(cost_cents=7, status='failed', **mcp)
        self.generation(cost_cents=590, status='queued', model='Seedance 2.5', kind='video', duration=30,
                        resolution='1080p', completed_at=None, **mcp)
        self.generation(age_ms=DAY - 1, cost_cents=3, **mcp)
        self.generation(age_ms=DAY, cost_cents=1000, **mcp)                                    # the window edge: out
        self.generation(cost_cents=100)                                                        # web
        self.generation(cost_cents=50, user_id=self.admin.id, **mcp)
        booked = controls.booked_cents('Seedance 2.5', 590, 30, '1080p')
        self.assertGreater(booked, 590)
        expected = 25 + 14 + 7 + booked + 3
        for module in (tool, controls):
            clock = patch.object(module, 'now_ms', return_value=self.now)
            clock.start()
            self.addCleanup(clock.stop)
        account = self.call(self.token(self.user), 'get_account').structured_content['spend']['todayCents']
        report = self.call(self.raw, 'admin_spend_report', {'days': 1, 'groupBy': 'user'}).structured_content
        rows = {row['key']: row for row in report['rows']}
        self.assertEqual((account, rows[str(self.user.id)]['mcpBookedCents']), (expected, expected))
        self.assertEqual((rows[str(self.admin.id)]['mcpBookedCents'], report['totals']['mcpBookedCents']), (50, expected + 50))
        self.assertEqual((rows[str(self.user.id)]['mcpCostCents'], rows[str(self.user.id)]['count']), (25 + 3, 7))

    def test_provider_errors_read_the_exact_records_with_keyset_pages(self):
        body = {'error': {'code': 'InputImageSensitiveContentDetected', 'message': 'The input image may contain sensitive content.',
                          'param': 'content[1]'}}
        older = self.generation(age_ms=3 * DAY, status='failed', model='Seedance 2.5', kind='video', error='Blocked',
                                provider_responses=[{'provider': 'seedance', 'httpStatus': 400, 'rawBody': json.dumps(body),
                                                     'requestId': 'req-1', 'receivedAt': 5}])
        newer = self.generation(age_ms=DAY, status='failed', model='Kling Image 3.0', error='x' * 10,
                                provider_responses=[{'provider': 'kling', 'httpStatus': 500, 'rawBody': 'Upstream model error. ' * 150}])
        self.generation()                                                                             # succeeded: not an error
        for era in ERAS:
            result = self.call(self.raw, 'admin_provider_errors', {}, era)
            self.assert_structured(result, tool.ERRORS_RESULT)
            found = result.structured_content
            self.assertEqual(([row['id'] for row in found['rows']], found['total'], found['nextCursor']),
                             ([str(newer.id), str(older.id)], 2, None))
        seedance = found['rows'][1]
        self.assertEqual({key: seedance[key] for key in ('source', 'userId', 'userEmail', 'kind', 'model', 'status', 'provider',
                                                         'httpStatus', 'code', 'message', 'param', 'requestId', 'error',
                                                         'rawBody', 'rawBodyTruncated', 'createdAt')},
                         {'source': 'generation', 'userId': str(self.user.id), 'userEmail': 'artist@example.invalid',
                          'kind': 'video', 'model': 'Seedance 2.5', 'status': 'failed', 'provider': 'seedance',
                          'httpStatus': 400, 'code': 'InputImageSensitiveContentDetected',
                          'message': 'The input image may contain sensitive content.', 'param': 'content[1]',
                          'requestId': 'req-1', 'error': 'Blocked', 'rawBody': json.dumps(body), 'rawBodyTruncated': False,
                          'createdAt': iso(older.created_at)})
        kling = found['rows'][0]
        self.assertEqual((len(kling['rawBody']), kling['rawBodyTruncated']), (2000, True))
        first = self.call(self.raw, 'admin_provider_errors', {'limit': 1}).structured_content
        self.assertEqual(([row['id'] for row in first['rows']], first['total']), ([str(newer.id)], 2))
        second = self.call(self.raw, 'admin_provider_errors', {'limit': 1, 'cursor': first['nextCursor']}).structured_content
        self.assertEqual(([row['id'] for row in second['rows']], second['nextCursor']), ([str(older.id)], None))
        since = self.call(self.raw, 'admin_provider_errors', {'since': iso(self.now - 2 * DAY)}).structured_content
        self.assertEqual([row['id'] for row in since['rows']], [str(newer.id)])
        until = self.call(self.raw, 'admin_provider_errors', {'until': iso(self.now - 2 * DAY)[:-1]}).structured_content
        self.assertEqual([row['id'] for row in until['rows']], [str(older.id)])          # a time without a zone is UTC
        for arguments, ids in (({'provider': 'seedance'}, [older.id]), ({'model': 'Kling Image 3.0'}, [newer.id]),
                               ({'code': 'SensitiveContent'}, [older.id]), ({'userId': str(self.admin.id)}, []),
                               ({'source': 'portrait'}, [])):
            listed = self.call(self.raw, 'admin_provider_errors', arguments).structured_content
            self.assertEqual(([row['id'] for row in listed['rows']], listed['total']), ([str(i) for i in ids], len(ids)), arguments)
        for arguments, text in (({'since': 'yesterday'}, 'since: use an ISO-8601 time'), ({'cursor': 'nonsense'}, 'cursor:'),
                                ({'limit': 101}, 'limit'), ({'provider': 'openai'}, 'provider')):
            refused = self.assert_tool_error(self.call(self.raw, 'admin_provider_errors', arguments), errors.INVALID_INPUT)
            self.assertIn(text, refused['message'])

    def test_system_status_runs_only_the_checks_this_service_can_answer(self):
        ran = []

        def check(identifier, result):
            def run():
                ran.append(identifier)
                return status.outcome(result, f'{identifier} {result}')
            return identifier, identifier.title(), run
        checks = [check('postgres', 'ok'), check('gemini', 'ok'), check('storage', 'ok'), check('ffmpeg-runtime', 'ok')]
        self.generation(status='running', created_via='mcp')
        self.generation(status='succeeded', created_via='mcp')
        with patch.object(status, 'CHECKS', checks):
            for era in ERAS:
                result = self.call(self.raw, 'admin_system_status', {}, era)
                self.assert_structured(result, tool.STATUS_RESULT)
                report = result.structured_content
                self.assertEqual([row['id'] for row in report['checks']], ['postgres', 'storage', 'ffmpeg-runtime'])
                self.assertEqual((report['healthy'], result.content[0].text.split('\n')[0]), (True, 'Every check passed.'))
                self.assertEqual(report['agents'], {'changesEnabled': True, 'maintenance': False, 'usersEnabled': 2,
                                                    'liveGrants': 1, 'activeJobs': 1})
                self.assertEqual(report['availableModels'], availability()['models'])
            self.assertNotIn('gemini', ran)                                   # provider credential checks never run here
            checks[2] = check('storage', 'error')
            AppSetting.objects.create(key=runtime.ADMIN_SWITCH, value='false', updated_at=1)
            result = self.call(self.raw, 'admin_system_status', {}, headers={'x-veevee-maintenance': '1'})
        report = result.structured_content
        self.assertEqual((report['healthy'], report['agents']['changesEnabled'], report['agents']['maintenance']),
                         (False, False, True))                               # a read tool still answers in maintenance
        self.assertTrue(result.content[0].text.startswith('Failing: Storage.'))
        self.assertEqual(tool.STATUS_CHECKS, ('postgres', 'generation-indexes', 'stuck-generations', 'storage',
                                              'ffmpeg-runtime', 'media-delivery'))
        self.assertTrue(set(tool.STATUS_CHECKS) <= {identifier for identifier, _, _ in status.CHECKS})

    def test_revoke_stops_one_user_or_one_grant_and_is_audited(self):
        artist = self.token(self.user, name='Artist laptop')
        spare = self.token(self.user, name='Artist desktop')
        claude = self.client_row()
        family = uuid.uuid4()
        _, access = tokens.issue(self.user, 'access', scopes=['veevee.read'], daily_cap_cents=500, auto_approve_cents=0,
                                 expires_at=10 ** 13, family_id=family, client=claude)
        tokens.issue(self.user, 'refresh', scopes=['veevee.read'], daily_cap_cents=500, auto_approve_cents=0,
                     expires_at=10 ** 13, family_id=family, client=claude)
        for era in ERAS:
            result = self.call(self.raw, 'admin_revoke_mcp_tokens', {'tokenId': str(access.id)}, era)
            self.assert_structured(result, tool.REVOKE_RESULT)
            revoked = 2 if era == ERAS[0] else 0                                     # revoking again is harmless
            self.assertEqual(result.structured_content, {'target': 'token', 'userId': str(self.user.id),
                                                         'tokenFamilyId': str(family), 'revokedTokens': revoked})
        self.assertEqual(McpToken.objects.filter(family_id=family, revoked_at__isnull=True).count(), 0)
        self.assertFalse(self.call(artist, 'get_account').is_error)                  # the user's other tokens still work
        by_family = self.call(self.raw, 'admin_revoke_mcp_tokens', {'tokenId': str(family)}).structured_content
        self.assertEqual((by_family['tokenFamilyId'], by_family['revokedTokens']), (str(family), 0))
        everything = self.call(self.raw, 'admin_revoke_mcp_tokens', {'userId': str(self.user.id)})
        self.assertEqual(everything.structured_content, {'target': 'user', 'userId': str(self.user.id), 'tokenFamilyId': None,
                                                         'revokedTokens': 2})
        for raw in (artist, spare):
            self.assertEqual(self.post(initialize_body(), {'authorization': f'Bearer {raw}'}).status_code, 401)
        self.assertFalse(self.call(self.raw, 'get_account').is_error)                # the admin's own token is untouched
        web = ActivityLog.objects.filter(action='admin_mcp_tokens_revoked', user_id=self.admin.id).order_by('created_at')
        self.assertEqual([row.detail for row in web][-1], {'targetUserId': str(self.user.id), 'revoked': 2, 'via': 'mcp'})
        self.assertEqual(web.first().detail, {'targetUserId': str(self.user.id), 'revoked': 2, 'via': 'mcp',
                                              'tokenFamilyId': str(family)})
        audit = ActivityLog.objects.filter(action='mcp_tool_call').order_by('created_at').last().detail
        self.assertEqual((audit['tool'], audit['outcome'], audit['targetUserId'], audit['revoked']),
                         ('admin_revoke_mcp_tokens', 'ok', str(self.user.id), 2))
        unknown = str(uuid.uuid4())
        for arguments in ({'userId': unknown}, {'tokenId': unknown}):
            self.assert_tool_error(self.call(self.raw, 'admin_revoke_mcp_tokens', arguments), errors.NOT_FOUND)
        for arguments in ({}, {'userId': str(self.user.id), 'tokenId': str(family)}, {'userId': 'me'}):
            self.assert_tool_error(self.call(self.raw, 'admin_revoke_mcp_tokens', arguments), errors.INVALID_INPUT)
        paused = self.call(self.raw, 'admin_revoke_mcp_tokens', {'userId': str(self.user.id)},
                           headers={'x-veevee-maintenance': '1'})
        self.assert_tool_error(paused, errors.MAINTENANCE)
        self.assertTrue(REGISTRY['admin_revoke_mcp_tokens'].destructive)

