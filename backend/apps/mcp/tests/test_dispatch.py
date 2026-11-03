"""``server.dispatch`` is the one tools/call path: HTTP MCP and the in-process Agents tab are admitted, validated,
logged, audited and rate counted identically."""
import asyncio
import json
import logging
import re
from unittest.mock import patch

from django.db import connection

from apps.common.models import ActivityLog
from apps.library.models import Folder
from apps.mcp import errors, server
from apps.mcp.registry import REGISTRY, ToolResult, obj, register
from apps.mcp_auth.principal import authenticate_bearer
from .support import McpCase
from .test_paid_tools import mid_minute

ORGANIZE = ('veevee.read', 'veevee.organize')
PROTOCOL = '2025-11-25'                          # what the legacy-era HTTP client negotiates
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def scenario(prefix):
    """(tool, arguments, maintenance) covering a read, a write, its replay, a schema refusal, a scope refusal and
    maintenance; ``prefix`` keeps the two runs' folders apart."""
    keyed = {'name': f'{prefix} Moodboard', 'idempotencyKey': f'{prefix}-moodboard'}
    return [('get_account', {}, False), ('create_folder', keyed, False), ('create_folder', keyed, False),
            ('create_folder', {'name': 7}, False), ('generate_image', {'prompt': 'red fox', 'wait': False}, False),
            ('create_folder', {'name': f'{prefix} Paused'}, True), ('list_folders', {}, False)]


def normal(value, prefix):
    """``value`` with ids, times and the run's prefix replaced, so the two runs compare equal."""
    text = UUID.sub('<id>', json.dumps(value, sort_keys=True)).replace(prefix, '<run>')
    return json.loads(re.sub(r'"(createdAt|updatedAt|expiresAt|urlsExpireAt)": "[^"]*"', r'"\1": "<time>"', text))


class DispatchParityTests(McpCase):
    def setUp(self):
        super().setUp()
        self.raw = self.token(scopes=ORGANIZE)
        self.principal = authenticate_bearer(self.raw)
        clock = patch('apps.mcp_auth.controls.now_ms', return_value=mid_minute())
        clock.start()
        self.addCleanup(clock.stop)
        self.lines = []
        capture = logging_capture(self.lines)
        capture.start()
        self.addCleanup(capture.stop)

    def calls_counted(self):
        with connection.cursor() as cursor:
            cursor.execute('SELECT coalesce(sum(count), 0) FROM mcp_rate_windows WHERE bucket = %s', [f'calls:{self.principal.token_id}'])
            return cursor.fetchone()[0]

    def audits(self):
        return list(ActivityLog.objects.filter(action='mcp_tool_call').order_by('created_at', 'id').values_list('detail', flat=True))

    def over_http(self):
        responses = []
        for name, arguments, maintenance in scenario('http'):
            result = self.call(self.raw, name, arguments, headers={'x-veevee-maintenance': '1'} if maintenance else None)
            responses.append((result.is_error, result.structured_content))
        return responses

    def in_process(self, tags=None):
        async def run():
            responses = []
            for name, arguments, maintenance in scenario('local'):
                done = await server.dispatch(self.principal, name, arguments, request_id='local-request', protocol_version=PROTOCOL,
                                             maintenance=maintenance, tags=tags)
                response = done.response
                responses.append((response.is_error, response.structured_content))
            return responses
        return asyncio.run(run())

    def test_http_and_in_process_calls_are_admitted_logged_audited_and_counted_alike(self):
        http = self.over_http()
        http_lines, http_audits, http_calls = list(self.lines), self.audits(), self.calls_counted()
        self.lines.clear()
        Folder.objects.all().delete()                  # list_folders then shows only this run's folder
        local = self.in_process()
        local_lines, local_audits = list(self.lines), self.audits()[len(http_audits):]
        self.assertEqual([normal(response, 'http') for response in http], [normal(response, 'local') for response in local])
        self.assertEqual([(error, body.get('code') if error else None) for error, body in local],
                         [(False, None), (False, None), (False, None), (True, errors.INVALID_INPUT),
                          (True, errors.INSUFFICIENT_SCOPE), (True, errors.MAINTENANCE), (False, None)])
        # One log line per call with the same fields and values, except the request id and timing.
        drop = lambda line: {key: value for key, value in line.items() if key not in ('request_id', 'duration_ms', 'generation_id')}  # noqa: E731
        self.assertEqual([drop(line) for line in http_lines], [drop(line) for line in local_lines])
        self.assertEqual(len(local_lines), len(scenario('local')))
        self.assertEqual({line['request_id'] for line in local_lines}, {'local-request'})
        self.assertEqual({line['protocol_version'] for line in http_lines}, {PROTOCOL})
        # Writes, and refused writes, are audited identically; reads are not audited.
        self.assertEqual([normal(audit, 'http') for audit in http_audits], [normal(audit, 'local') for audit in local_audits])
        self.assertEqual([(audit['tool'], audit['outcome']) for audit in local_audits],
                         [('create_folder', 'ok'), ('create_folder', 'ok'), ('create_folder', errors.INVALID_INPUT),
                          ('generate_image', errors.INSUFFICIENT_SCOPE), ('create_folder', errors.MAINTENANCE)])
        # The grant's call rate counts the same calls whichever way they arrived: all but the scope and maintenance
        # refusals, which end admission before the rate check (a schema refusal still counts).
        self.assertEqual((http_calls, self.calls_counted()), (5, 10))

    def test_admission_runs_before_validation_and_the_handler(self):
        order = []

        async def handler(call):
            order.append('handler')
            return ToolResult({}, 'Done.')
        real_admit, real_finish = server.admit, server.finish

        async def admit(spec, call):
            order.append('admit')
            await real_admit(spec, call)

        async def finish(spec, call, outcome):
            order.append(('finish', outcome))
            await real_finish(spec, call, outcome)
        with patch.dict(REGISTRY):
            register(name='fake_write', title='Fake', description='Test.', scope='veevee.organize', read_only=False,
                     input_schema=obj({'n': {'type': 'integer'}}), output_schema=obj({}))(handler)
            validate = REGISTRY['fake_write'].validate
            with patch.object(server, 'admit', admit), patch.object(server, 'finish', finish), \
                    patch.object(type(REGISTRY['fake_write']), 'validate', lambda spec, arguments: order.append('validate') or validate(arguments)):
                for arguments, maintenance in (({'n': 1}, False), ({'n': 'x'}, False), ({'n': 1}, True)):
                    asyncio.run(server.dispatch(self.principal, 'fake_write', arguments, request_id='r', protocol_version=PROTOCOL,
                                                maintenance=maintenance))
        self.assertEqual(order, ['admit', 'validate', 'handler', ('finish', 'ok'),
                                 'admit', 'validate', ('finish', errors.INVALID_INPUT),
                                 'admit', ('finish', errors.MAINTENANCE)])

    def test_unknown_tools_and_tags(self):
        with self.assertRaises(server.UnknownTool):
            asyncio.run(server.dispatch(self.principal, 'no_such_tool', {}, request_id='r', protocol_version=PROTOCOL))
        with self.assertRaises(ValueError):
            asyncio.run(server.dispatch(self.principal, 'get_account', {}, request_id='r', protocol_version=PROTOCOL,
                                        tags={'prompt': 'red fox'}))
        self.assertEqual((self.lines, self.calls_counted()), ([], 0))
        tags = {'runId': 'run-1', 'stepIndex': 3}
        asyncio.run(server.dispatch(self.principal, 'create_folder', {'name': 'Tagged'}, request_id='r', protocol_version=PROTOCOL,
                                    tags=tags))
        self.assertEqual(self.lines[-1]['tags'], tags)
        self.assertEqual({key: self.audits()[-1][key] for key in tags}, tags)
        self.assertNotIn('tags', self.over_http_line())

    def over_http_line(self):
        self.call(self.raw, 'get_account')
        return self.lines[-1]


def logging_capture(lines):
    """Collect each ``veevee.mcp`` log line as JSON into ``lines``."""
    class Collect(logging.Handler):
        def emit(self, record):
            if record.levelno == logging.INFO:
                lines.append(json.loads(record.getMessage()))
    logger = logging.getLogger('veevee.mcp')
    return patch.multiple(logger, handlers=[Collect()], level=logging.INFO, propagate=False)
