"""The trusted client address: only a proof minted by our own gateway makes an address count."""
import hashlib
import time

from django.test import RequestFactory, SimpleTestCase, override_settings

from apps.common import client_address

KEY = 'k' * 64


def request(address=None, proof=None, **extra):
    headers = dict(extra)
    if address is not None:
        headers['X-Veevee-Client-Ip'] = address
    if proof is not None:
        headers['X-Veevee-Client-Ip-Proof'] = proof
    return RequestFactory().get('/', headers=headers)


@override_settings(VEEVEE_CLIENT_ADDRESS_KEY=KEY, VEEVEE_ADDRESS_RATE_LIMITS=True)
class TrustedAddressTests(SimpleTestCase):
    def signed(self, address, **kwargs):
        return request(address, client_address.sign(KEY, address, **kwargs))

    def test_a_fresh_proof_vouches_for_the_address(self):
        self.assertEqual(client_address.trusted_address(self.signed('8.8.8.8')), '8.8.8.8')

    def test_a_forged_mismatched_malformed_or_missing_proof_is_untrusted(self):
        good = client_address.sign(KEY, '8.8.8.8')
        other_key = client_address.sign('z' * 64, '8.8.8.8')
        cases = [
            request('8.8.8.8'),
            request(None, good),
            request('8.8.8.8', other_key),
            request('1.1.1.1', good),  # a valid proof for a different address
            request('8.8.8.8', 'v1.1.' + '0' * 64),
            request('8.8.8.8', 'garbage'),
            request('8.8.8.8', good + '.extra'),
            request('8.8.8.8', 'v2.' + good[3:]),
            request('8.8.8.8', 'v1.notanumber.' + '0' * 64),
            request('8.8.8.8', ''),
        ]
        for case in cases:
            self.assertIsNone(client_address.trusted_address(case), dict(case.headers))

    def test_a_stale_or_future_proof_is_untrusted_but_clock_skew_is_tolerated(self):
        now = time.time()
        for offset, trusted in ((0, True), (-60, True), (60, True), (-200, False), (200, False), (-86400, False)):
            result = client_address.trusted_address(self.signed('8.8.8.8', now=now + offset), now=now)
            self.assertEqual(result is not None, trusted, offset)

    def test_a_proof_is_bound_to_the_address_it_signed(self):
        proof = client_address.sign(KEY, '8.8.8.8')
        self.assertIsNone(client_address.trusted_address(request('8.8.4.4', proof)))

    def test_forwarded_for_and_real_ip_never_establish_an_address(self):
        spoofed = request(None, None, **{'X-Forwarded-For': '8.8.8.8', 'X-Real-Ip': '8.8.8.8'})
        self.assertIsNone(client_address.trusted_address(spoofed))
        self.assertIsNone(client_address.address_key(spoofed))
        # Even next to a valid proof for a different address, only the signed header counts.
        mixed = request('1.1.1.1', client_address.sign(KEY, '1.1.1.1'), **{'X-Forwarded-For': '8.8.8.8'})
        self.assertEqual(client_address.trusted_address(mixed), '1.1.1.1')

    def test_without_a_configured_key_nothing_is_trusted(self):
        with override_settings(VEEVEE_CLIENT_ADDRESS_KEY=''):
            self.assertIsNone(client_address.trusted_address(self.signed('8.8.8.8')))

    def test_non_global_addresses_are_untrusted_even_when_signed(self):
        for address in ('10.0.0.1', '127.0.0.1', '192.168.1.5', '169.254.1.1', '100.64.0.1', '203.0.113.9', '198.51.100.7',
                        '::1', 'fe80::1', 'fc00::1', '0.0.0.0', 'not-an-ip', '8.8.8.8, 1.1.1.1', ''):
            self.assertIsNone(client_address.trusted_address(self.signed(address)), address)

    def test_canonical_forms(self):
        self.assertEqual(client_address.canonical('8.8.8.8'), '8.8.8.8')
        self.assertEqual(client_address.canonical(' 8.8.8.8 '), '8.8.8.8')
        self.assertEqual(client_address.canonical('::ffff:8.8.8.8'), '8.8.8.8')
        self.assertEqual(client_address.canonical('2606:4700:4700::1111'), '2606:4700:4700::/64')
        self.assertEqual(client_address.canonical('2606:4700:4700:0:1:2:3:4'), '2606:4700:4700::/64')
        self.assertNotEqual(client_address.canonical('2606:4700:4701::1'), client_address.canonical('2606:4700:4700::1'))

    def test_one_ipv6_subscriber_cannot_mint_buckets_by_rotating_the_low_bits(self):
        keys = {client_address.address_key(self.signed(f'2606:4700:4700:0:{suffix:x}::1')) for suffix in range(1, 40)}
        self.assertEqual(len(keys), 1)

    def test_the_bucket_key_is_a_hash_of_the_canonical_address(self):
        key = client_address.address_key(self.signed('8.8.8.8'))
        self.assertEqual(key, hashlib.sha256(b'8.8.8.8').hexdigest()[:32])
        self.assertNotIn('8.8.8.8', key)

    def test_the_switch_turns_every_address_limit_off(self):
        with override_settings(VEEVEE_ADDRESS_RATE_LIMITS=False):
            self.assertIsNone(client_address.address_key(self.signed('8.8.8.8')))
            self.assertEqual(client_address.trusted_address(self.signed('8.8.8.8')), '8.8.8.8')
