"""Milestone 6: upload_reference (URL import, inline base64, signed upload sessions) and OmniHuman through MCP.

URL imports never reach the network: the public-HTTPS fetcher gets a fake resolver and connection, so the SSRF rules
(https on 443, public addresses only, every redirect re-checked, at most 3 redirects, per-kind size caps) are tested
against the real ``integrations.remote`` code. Stored files go through the web's upload sessions on local storage.
"""
import base64
import hashlib
import io
import ipaddress
import math
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from apps.admin_dashboard.models import Pricing
from apps.common.models import ActivityLog
from apps.generation.models import Generation
from apps.generation.test_omnihuman import audio
from apps.integrations.errors import MediaTooLargeError
from apps.integrations.remote import SafeMediaFetcher, UnsafeMediaURL, validated_target
from apps.media.models import UploadSession
from apps.mcp import results
from apps.mcp.tools import uploads as tool
from apps.mcp_auth import policy
from .support import ERAS, SITE, McpCase
from .test_paid_tools import mid_minute
from .test_results import StorageMixin, png_bytes

PUBLIC = '93.184.216.34'


class Response:
    def __init__(self, status, headers, body):
        self.status, self.headers, self.body = status, headers, io.BytesIO(body)
        self.reads = 0

    def getheader(self, name):
        return self.headers.get(name)

    def read(self, amount):
        self.reads += 1
        return self.body.read(amount)


class Internet:
    """A fake internet: host -> address, and (host, path) -> (status, headers, body)."""

    def __init__(self, pages, addresses=None):
        self.pages, self.addresses, self.requests, self.responses = pages, addresses or {}, [], []

    def resolver(self, host, port, type=None, **options):
        return [(2, 1, 6, '', (address, port)) for address in self.addresses.get(host, [PUBLIC])]

    def connection(self, host, address, timeout):
        internet = self

        class Connection:
            def request(self, method, path, headers=None):
                internet.requests.append((host, address, path))
                self.page = internet.pages[(host, path)]

            def getresponse(self):
                status, headers, body = self.page
                response = Response(status, headers, body)
                internet.responses.append(response)
                return response

            def close(self):
                pass
        return Connection()

    def fetcher(self, **options):
        return SafeMediaFetcher(None, resolver=self.resolver, connection=self.connection,
                                **{'max_bytes': max(tool.IMPORT_BYTES.values()), 'timeout': 20,
                                   'total_timeout': tool.IMPORT_SECONDS, 'max_redirects': tool.IMPORT_REDIRECTS, **options})


def embedded_ipv4_forms(inner):
    """Every IPv6 spelling that carries ``inner``: mapped, compatible, NAT64 (both prefixes), 6to4 and Teredo."""
    value = int(ipaddress.IPv4Address(inner))
    high, low = f'{value >> 16:x}', f'{value & 0xffff:x}'
    teredo = ipaddress.IPv6Address((0x20010000 << 96) | (0x41369c24 << 64) | (0x8000 << 48) | (0xfb13 << 32) | (value ^ 0xffffffff))
    return (f'::ffff:{inner}', f'::{inner}', f'64:ff9b::{inner}', f'64:ff9b:1::{high}:{low}', f'2002:{high}:{low}::1', str(teredo))


def page(body, mime, *, status=200, length=True):
    headers = {'Content-Type': mime, **({'Content-Length': str(len(body))} if length else {})}
    return status, headers, body


def redirect(location, status=302):
    return status, {'Location': location}, b''


class PublicFetchTests(SimpleTestCase):
    """The pinned public-DNS fetcher in public-HTTPS mode (``allowed_hosts=None``)."""

    def test_public_mode_takes_any_public_host_but_refuses_unsafe_urls_and_addresses(self):
        public = lambda *a, **k: [(2, 1, 6, '', (PUBLIC, 443))]
        self.assertEqual(validated_target('https://cdn.anywhere.example/a.png?x=1', None, public),
                         ('cdn.anywhere.example', PUBLIC, '/a.png?x=1'))
        for url in ('http://cdn.example/a', 'https://cdn.example:8443/a', 'https://user:pass@cdn.example/a',
                    'ftp://cdn.example/a', 'https:///a', 'file:///etc/passwd'):
            with self.subTest(url=url), self.assertRaises(UnsafeMediaURL):
                validated_target(url, None, public)
        for address in ('127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
                        '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '192.0.2.1', '224.0.0.1'):
            with self.subTest(address=address), self.assertRaises(UnsafeMediaURL):
                validated_target('https://cdn.example/a', None, lambda *a, **k: [(2, 1, 6, '', (address, 443))])
        mixed = lambda *a, **k: [(2, 1, 6, '', (PUBLIC, 443)), (2, 1, 6, '', ('10.0.0.5', 443))]
        with self.assertRaises(UnsafeMediaURL):
            validated_target('https://rebind.example/a', None, mixed)
        # The provider allowlist mode is unchanged.
        with self.assertRaises(UnsafeMediaURL):
            validated_target('https://cdn.anywhere.example/a', ['media.example'], public)

    def test_ipv6_forms_that_embed_an_ipv4_address_are_refused(self):
        for inner in ('169.254.169.254', '127.0.0.1', '10.0.0.8', '192.168.1.1', '8.8.8.8'):
            for address in embedded_ipv4_forms(inner):
                for allowed in (None, ['cdn.example']):
                    with self.subTest(address=address, allowed=allowed), self.assertRaises(UnsafeMediaURL):
                        validated_target('https://cdn.example/a', allowed, lambda *a, **k: [(10, 1, 6, '', (address, 443, 0, 0))])
        for address in ('2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e'):
            with self.subTest(address=address):
                self.assertEqual(validated_target('https://cdn.example/a', None, lambda *a, **k: [(10, 1, 6, '', (address, 443, 0, 0))])[1],
                                 address)

    def test_redirects_are_rechecked_capped_at_three_and_pinned_to_the_checked_address(self):
        image = png_bytes(32, 32)
        internet = Internet({('a.example', '/1'): redirect('https://b.example/2'),
                             ('b.example', '/2'): redirect('/3', 307),
                             ('b.example', '/3'): redirect('https://c.example/4'),
                             ('c.example', '/4'): page(image, 'image/png')},
                            {'c.example': ['203.0.114.7']})
        with internet.fetcher().open_file('https://a.example/1') as (stream, mime):
            self.assertEqual((stream.read(), mime), (image, 'image/png'))
        self.assertEqual(internet.requests, [('a.example', PUBLIC, '/1'), ('b.example', PUBLIC, '/2'),
                                             ('b.example', PUBLIC, '/3'), ('c.example', '203.0.114.7', '/4')])
        internet.pages[('c.example', '/4')] = redirect('https://d.example/5')
        internet.pages[('d.example', '/5')] = page(image, 'image/png')
        with self.assertRaisesRegex(ValueError, 'Too many'):
            with internet.fetcher().open_file('https://a.example/1'):
                pass
        for target, addresses in (('https://metadata.example/latest', {'metadata.example': ['169.254.169.254']}),
                                  ('http://c.example/plain', {}), ('https://c.example:444/port', {})):
            hop = Internet({('a.example', '/1'): redirect(target)}, addresses)
            with self.subTest(target=target), self.assertRaises(UnsafeMediaURL):
                with hop.fetcher().open_file('https://a.example/1'):
                    pass
            self.assertEqual(len(hop.requests), 1)       # the unsafe hop is never connected to

    def test_type_limits_apply_before_the_body_is_read(self):
        big = Internet({('a.example', '/voice.wav'): (200, {'Content-Type': 'audio/wav', 'Content-Length': str(15 * 1024 * 1024 + 1)}, b'')})
        limit = lambda mime: tool.IMPORT_BYTES[tool.purpose_of(mime)[0]]
        with self.assertRaises(MediaTooLargeError):
            with big.fetcher().open_file('https://a.example/voice.wav', limit_for=limit):
                pass
        self.assertEqual(big.responses[0].reads, 0)
        html = Internet({('a.example', '/page'): page(b'<html>', 'text/html; charset=utf-8')})
        with self.assertRaisesRegex(tool.Unsupported, 'text/html'):
            with html.fetcher().open_file('https://a.example/page', limit_for=limit):
                pass
        self.assertEqual(html.responses[0].reads, 0)
        streamed = Internet({('a.example', '/big.png'): page(b'\x89PNG' + b'x' * 2000, 'image/png', length=False)})
        with patch.dict(tool.IMPORT_BYTES, {'image-reference': 1000}), self.assertRaises(MediaTooLargeError):
            with streamed.fetcher().open_file('https://a.example/big.png', limit_for=limit):
                pass

    def test_the_tool_fetcher_is_public_https_with_the_import_bounds(self):
        fetcher = tool.fetcher()
        self.assertEqual((fetcher.allowed_hosts, fetcher.max_redirects, fetcher.total_timeout, fetcher.max_bytes),
                         (None, 3, 45, 200 * 1024 * 1024))
        self.assertEqual(tool.IMPORT_BYTES, {'image-reference': 30 * 1024 * 1024, 'audio-reference': 15 * 1024 * 1024,
                                             'video-reference': 200 * 1024 * 1024})


class UploadToolTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token()
        pinned = mid_minute()
        for target in ('apps.mcp.paid.now_ms', 'apps.mcp_auth.controls.now_ms'):
            clock = patch(target, return_value=pinned)
            clock.start()
            self.addCleanup(clock.stop)
        self.png = png_bytes(600, 400)

    def upload(self, arguments, raw=None, mode='legacy'):
        return self.call(raw or self.raw, 'upload_reference', arguments, mode)

    def ready(self, result):
        self.assert_structured(result, tool.UPLOAD_RESULT)
        body = result.structured_content
        self.assertEqual((body['outcome'], body['upload'], body['next']), ('ready', None, None))
        return body['reference']

    def internet(self, pages, addresses=None):
        internet = Internet(pages, addresses)
        replaced = patch.object(tool, 'fetcher', internet.fetcher)
        replaced.start()
        self.addCleanup(replaced.stop)
        return internet

    def inline(self, data, mime, **arguments):
        return self.upload({'dataBase64': base64.b64encode(data).decode(), 'contentType': mime, **arguments})

    def test_scope_listing_and_annotations(self):
        self.assertNotIn('upload_reference', self.tool_names(self.token(scopes=('veevee.read',))))
        for era in ERAS:
            async def find(client):
                return next(t for t in (await client.list_tools()).tools if t.name == 'upload_reference')
            found = self.with_client(self.raw, era, find)
            hints = found.annotations
            self.assertEqual((hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint, hints.open_world_hint),
                             (False, False, True, True))
            self.assertTrue(found.description.startswith('Add a reference file (image, audio or video) from a public https URL'))

    def test_url_import_stores_a_ready_owned_upload_through_the_session_checks(self):
        internet = self.internet({('cdn.example', '/shots/hero%20one.png'): page(self.png, 'image/png')})
        for era in ERAS:
            UploadSession.objects.all().delete()
            reference = self.ready(self.upload({'url': 'https://cdn.example/shots/hero%20one.png'}, mode=era))
            row = UploadSession.objects.get(pk=reference['id'])
            self.assertEqual((row.actor_id, row.purpose, row.state, row.content_type, row.byte_size, row.filename),
                             (self.user.id, 'image-reference', 'ready', 'image/png', len(self.png), 'hero one.png'))
            self.assertEqual(self.storage.read(row.key), self.png)
            self.assertEqual(reference, {'id': str(row.id), 'kind': 'image', 'contentType': 'image/png', 'bytes': len(self.png),
                                         'filename': 'hero one.png', 'sha256': hashlib.sha256(self.png).hexdigest(),
                                         'state': 'ready', 'usableIn': tool.USABLE['image']})
        self.assertEqual(internet.requests[-1], ('cdn.example', PUBLIC, '/shots/hero%20one.png'))
        audit = ActivityLog.objects.filter(action='mcp_tool_call').latest('created_at').detail
        self.assertEqual((audit['tool'], audit['outcome'], audit['referenceId']), ('upload_reference', 'ready', reference['id']))
        self.assertNotIn('cdn.example', str(audit))

    def test_url_import_refusals_store_nothing(self):
        self.internet({('inside.example', '/a.png'): page(self.png, 'image/png'),
                       ('cdn.example', '/page'): page(b'<html></html>', 'text/html'),
                       ('cdn.example', '/fake.png'): page(b'not really a png at all', 'image/png'),
                       ('cdn.example', '/gone.png'): page(b'', 'text/plain', status=404),
                       ('cdn.example', '/long.wav'): (200, {'Content-Type': 'audio/wav', 'Content-Length': str(16 * 1024 * 1024)}, b''),
                       ('cdn.example', '/hop'): redirect('https://inside.example/a.png')},
                      {'inside.example': ['10.0.0.8'], 'nat64.example': ['64:ff9b::a9fe:a9fe'], 'compat.example': ['::127.0.0.1']})
        cases = {'https://inside.example/a.png': 'private and reserved networks are refused',
                 'https://nat64.example/a.png': 'private and reserved networks are refused',
                 'https://compat.example/a.png': 'private and reserved networks are refused',
                 'https://cdn.example/hop': 'private and reserved networks are refused',
                 'https://cdn.example/page': 'text/html',
                 'https://cdn.example/fake.png': 'not a image/png file',
                 'https://cdn.example/gone.png': 'HTTP 404',
                 'https://cdn.example/long.wav': 'audio 15 MB'}
        for url, text in cases.items():
            with self.subTest(url=url):
                error = self.assert_tool_error(self.upload({'url': url}), 'INVALID_INPUT')
                self.assertIn(text, error['message'])
        self.assert_tool_error(self.upload({'url': 'http://cdn.example/a.png'}), 'INVALID_INPUT')     # the schema wants https
        self.assertFalse(UploadSession.objects.exclude(state='cancelled').exists())
        self.assertEqual(sorted(path.name for path in self.storage.primary.root.rglob('*') if path.is_file()), [])

    def test_content_type_argument_overrides_a_generic_header(self):
        self.internet({('cdn.example', '/download'): page(self.png, 'application/octet-stream')})
        self.assert_tool_error(self.upload({'url': 'https://cdn.example/download'}), 'INVALID_INPUT')
        reference = self.ready(self.upload({'url': 'https://cdn.example/download', 'contentType': 'image/png', 'filename': 'hero.png'}))
        self.assertEqual((reference['contentType'], reference['filename']), ('image/png', 'hero.png'))

    def test_inline_base64_with_and_without_a_data_url_prefix(self):
        reference = self.ready(self.inline(self.png, 'image/png', filename='hero.png'))
        self.assertEqual(UploadSession.objects.get(pk=reference['id']).filename, 'hero.png')
        wav = audio(5)
        data_url = 'data:audio/wav;base64,' + base64.b64encode(wav).decode()
        sound = self.ready(self.upload({'dataBase64': data_url}))
        self.assertEqual((sound['kind'], sound['contentType'], sound['usableIn']), ('audio', 'audio/wav', ['generate_video.referenceAudioIds']))
        self.assertEqual(self.storage.read(UploadSession.objects.get(pk=sound['id']).key), wav)
        for arguments, text in (({'dataBase64': base64.b64encode(self.png).decode()}, 'contentType is required'),
                                ({'dataBase64': 'not base64!', 'contentType': 'image/png'}, 'not valid base64'),
                                ({'dataBase64': base64.b64encode(b'x' * (tool.INLINE_BYTES + 1)).decode(), 'contentType': 'image/png'}, '2.5 MB'),
                                ({'dataBase64': base64.b64encode(b'text').decode(), 'contentType': 'text/plain'}, 'not an image, audio or video'),
                                ({'dataBase64': base64.b64encode(b'text').decode(), 'contentType': 'image/png'}, 'not a image/png file')):
            with self.subTest(text=text):
                self.assertIn(text, self.assert_tool_error(self.upload(arguments), 'INVALID_INPUT')['message'])

    def test_replays_return_the_same_reference_and_a_reused_key_with_other_bytes_conflicts(self):
        first = self.ready(self.inline(self.png, 'image/png'))
        self.assertEqual(self.ready(self.inline(self.png, 'image/png'))['id'], first['id'])
        keyed = self.ready(self.inline(self.png, 'image/png', idempotencyKey='hero-upload-1'))
        self.assertNotEqual(keyed['id'], first['id'])
        self.assertEqual(self.ready(self.inline(self.png, 'image/png', idempotencyKey='hero-upload-1'))['id'], keyed['id'])
        self.assert_tool_error(self.inline(png_bytes(400, 400), 'image/png', idempotencyKey='hero-upload-1'), 'IDEMPOTENCY_CONFLICT')
        self.assertEqual(UploadSession.objects.count(), 2)

    def put(self, upload, data):
        path = upload['url'][len(SITE):]
        return self.client.put(path, data=data, content_type=upload['headers']['Content-Type'])

    def test_signed_upload_session_then_finalize(self):
        wav = audio(6)
        started = self.upload({'contentType': 'audio/wav', 'byteSize': len(wav), 'filename': 'voice.wav',
                               'sha256': hashlib.sha256(wav).hexdigest()})
        self.assert_structured(started, tool.UPLOAD_RESULT)
        body = started.structured_content
        identifier = body['reference']['id']
        self.assertEqual((body['outcome'], body['reference']['state'], body['upload']['method'], body['upload']['headers']),
                         ('upload_pending', 'uploading', 'PUT', {'Content-Type': 'audio/wav'}))
        self.assertTrue(body['upload']['url'].startswith(SITE + '/api/uploads/local?t='))
        self.assertEqual(body['next'], results.call('upload_reference', {'uploadId': identifier}, body['next']['why']))
        early = self.upload({'uploadId': identifier})
        self.assert_structured(early, tool.UPLOAD_RESULT)
        self.assertEqual(early.structured_content['outcome'], 'upload_pending')
        self.assertEqual(self.put(body['upload'], wav).status_code, 200)
        reference = self.ready(self.upload({'uploadId': identifier}))
        self.assertEqual((reference['id'], reference['bytes'], reference['sha256']), (identifier, len(wav), hashlib.sha256(wav).hexdigest()))
        self.assertEqual(self.ready(self.upload({'uploadId': identifier.upper()}))['id'], identifier)     # finalize is idempotent

        wrong = self.upload({'contentType': 'image/png', 'byteSize': 24})
        target = wrong.structured_content['upload']
        self.assertEqual(self.put(target, b'not a png, just 24 byte').status_code, 200)
        self.assert_tool_error(self.upload({'uploadId': wrong.structured_content['reference']['id']}), 'INVALID_INPUT')
        row = UploadSession.objects.get(pk=wrong.structured_content['reference']['id'])
        self.assertEqual(row.state, 'cancelled')
        self.assertFalse(self.storage.primary._path(row.key).exists())
        self.assert_tool_error(self.upload({'uploadId': str(row.id)}), 'NOT_FOUND')

    def test_uploads_are_owner_only(self):
        other = self.make_user('other@example.invalid', 'Other', 'user')
        theirs = self.ready(self.call(self.token(other), 'upload_reference',
                                      {'dataBase64': base64.b64encode(self.png).decode(), 'contentType': 'image/png'}))
        error = self.assert_tool_error(self.upload({'uploadId': theirs['id']}), 'NOT_FOUND')
        self.assertNotIn('Other', error['message'])
        self.assert_tool_error(self.call(self.raw, 'generate_image', {'prompt': 'fox', 'referenceIds': [theirs['id']], 'wait': False}), 'NOT_FOUND')
        self.assertFalse(Generation.objects.exists())

    def test_argument_combinations_and_the_upload_rate(self):
        data = base64.b64encode(self.png).decode()
        for arguments in ({}, {'url': 'https://cdn.example/a.png', 'dataBase64': data}, {'byteSize': 10},
                          {'uploadId': '00000000-0000-4000-8000-000000000000', 'filename': 'x'},
                          {'dataBase64': data, 'contentType': 'image/png', 'sha256': '0' * 64}):
            with self.subTest(arguments=list(arguments)):
                self.assert_tool_error(self.upload(arguments), 'INVALID_INPUT')
        with patch.dict(policy.RATE_LIMITS, {'uploads': (2, 3600)}):
            self.ready(self.inline(self.png, 'image/png', idempotencyKey='rate-key-0001'))
            self.ready(self.inline(self.png, 'image/png', idempotencyKey='rate-key-0002'))
            self.assert_tool_error(self.inline(self.png, 'image/png', idempotencyKey='rate-key-0003'), 'RATE_LIMITED')

    def test_generate_takes_owned_ready_uploads_in_reference_fields(self):
        Pricing.objects.bulk_create([Pricing(model='Nano Banana 2.1', unit_cost_cents=4, unit='per_image', notes='')], ignore_conflicts=True)
        image = self.ready(self.inline(self.png, 'image/png'))
        sound = self.ready(self.inline(audio(5), 'audio/wav'))
        result = self.call(self.raw, 'generate_image', {'prompt': 'fox like @img1', 'referenceIds': [image['id']], 'wait': False})
        self.assert_structured(result, results.RESULT_SCHEMA)
        row = Generation.objects.get(pk=result.structured_content['generation']['id'])
        self.assertEqual(row.created_via, 'mcp')
        self.assertEqual(len(row.reference_images), 1)
        error = self.assert_tool_error(self.call(self.raw, 'generate_image', {'prompt': 'fox', 'referenceIds': [sound['id']], 'wait': False}),
                                       'INVALID_INPUT')
        self.assertIn('is a audio file; referenceIds takes image files', error['message'])
        started = self.upload({'contentType': 'image/png', 'byteSize': len(self.png)}).structured_content
        unfinished = self.assert_tool_error(self.call(self.raw, 'generate_image', {'prompt': 'fox', 'wait': False,
                                                                                    'referenceIds': [started['reference']['id']]}), 'INVALID_INPUT')
        self.assertEqual(unfinished['next']['arguments'], {'uploadId': started['reference']['id']})
        self.assertEqual(Generation.objects.count(), 1)

    @override_settings(VEEVEE_OMNIHUMAN=True)
    def test_omnihuman_runs_from_an_uploaded_image_and_audio(self):
        Pricing.objects.bulk_create([Pricing(model='OmniHuman 2.0', unit_cost_cents=7, unit='per_second', notes='')], ignore_conflicts=True)
        raw = self.token(auto_approve=50)
        async def models(client):
            return (await client.call_tool('list_models', {})).structured_content['models']
        listed = next(m for m in self.with_client(raw, 'legacy', models) if m['id'] == 'omnihuman-2')
        self.assertTrue(listed['inputs']['durationSeconds']['inputDriven'])
        wav = audio(4.2)
        image = self.ready(self.call(raw, 'upload_reference', {'dataBase64': base64.b64encode(self.png).decode(), 'contentType': 'image/png'}))
        sound = self.ready(self.call(raw, 'upload_reference', {'dataBase64': base64.b64encode(wav).decode(), 'contentType': 'audio/wav'}))
        arguments = {'model': 'omnihuman-2', 'referenceImageIds': [image['id']], 'referenceAudioIds': [sound['id']]}
        quote = self.call(raw, 'estimate_cost', {'tool': 'generate_video', 'arguments': arguments}).structured_content
        self.assertEqual((quote['costCents'], quote['autoApproves']), (math.ceil(4.2) * 7, True))
        for era in ERAS:
            Generation.objects.all().delete()
            result = self.call(raw, 'generate_video', {**arguments, 'wait': False, 'idempotencyKey': f'omni-{era}'}, era)
            self.assert_structured(result, results.RESULT_SCHEMA)
            row = Generation.objects.get(pk=result.structured_content['generation']['id'])
            key = UploadSession.objects.get(pk=sound['id']).key
            self.assertEqual((row.model, row.duration, row.cost_cents, row.reference_audios, row.created_via),
                             ('OmniHuman 2.0', 5, 35, ['/api/media/' + key], 'mcp'))
        short = self.ready(self.call(raw, 'upload_reference', {'dataBase64': base64.b64encode(audio(2)).decode(), 'contentType': 'audio/wav'}))
        error = self.assert_tool_error(self.call(raw, 'generate_video', {**arguments, 'referenceAudioIds': [short['id']], 'wait': False}),
                                       'INVALID_INPUT')
        self.assertIn('audio', error['message'].lower())
