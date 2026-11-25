"""The layered login throttle: account, account-at-address and address layers, backoff, reservation and fallbacks."""
import os
import threading
from unittest.mock import patch

from django.db import connections
from django.test import TransactionTestCase

from apps.common.ratelimit import Tier
from apps.mcp_auth import ratelimits
from . import throttle
from .models import LoginAttempt

A, B = 'a' * 32, 'b' * 32  # address bucket keys
WINDOW = 15 * 60 * 1000


def env(**values):
    return patch.dict(os.environ, {key: value for key, value in values.items()})


class LayerTests(TransactionTestCase):
    def attempt(self, email, now, address=None):
        return throttle.admit(email, now=now, address_key=address)

    def test_the_account_layer_admits_five_then_refuses_with_an_exact_wait(self):
        for offset in range(5):
            self.assertTrue(self.attempt('a@example.invalid', 1000 + offset)['allowed'])
        refused = self.attempt('a@example.invalid', 2000)
        self.assertEqual((refused['allowed'], refused['layer'], refused['retryAfterMs']), (False, 'login_account', 1000 + WINDOW - 2000))
        self.assertEqual(self.attempt('a@example.invalid', 1000 + WINDOW)['allowed'], True)  # the first failure aged out exactly then

    def test_a_refused_attempt_writes_nothing_so_hammering_does_not_extend_the_lockout(self):
        for offset in range(5):
            self.attempt('a@example.invalid', 1000 + offset)
        for index in range(30):
            self.assertFalse(self.attempt('a@example.invalid', 2000 + index)['allowed'])
        self.assertEqual(LoginAttempt.objects.count(), 5)
        self.assertEqual(self.attempt('a@example.invalid', 2000)['retryAfterMs'], 1000 + WINDOW - 2000)

    def test_backoff_tiers_extend_the_lock_for_persistent_guessing(self):
        for offset in range(5):
            self.assertTrue(self.attempt('a@example.invalid', offset)['allowed'])
        for offset in range(5):  # a patient guesser waits out 15 minutes and goes on
            self.assertTrue(self.attempt('a@example.invalid', 901_000 + offset)['allowed'])
        now = 902_000
        refused = self.attempt('a@example.invalid', now)
        self.assertEqual((refused['allowed'], refused['layer']), (False, 'login_account'))
        self.assertEqual(refused['retryAfterMs'], 0 + 3600_000 - now)  # the hour tier, not the 15-minute one
        later = 3600_000 + 4  # five failures at 0..4 have left the hour window; the second five are still in it
        self.assertTrue(self.attempt('a@example.invalid', later)['allowed'])
        daily = [Tier(5, 900), Tier(10, 3600), Tier(20, 86400)]
        self.assertEqual(throttle.tiers_for(throttle.ACCOUNT, 5), tuple(daily))

    def test_the_pair_layer_limits_one_account_at_one_address(self):
        with env(VEEVEE_RL_LOGIN_ACCOUNT='off', VEEVEE_RL_LOGIN_ADDRESS='off'):
            for offset in range(10):
                self.assertTrue(self.attempt('a@example.invalid', 1000 + offset, A)['allowed'])
            refused = self.attempt('a@example.invalid', 2000, A)
            self.assertEqual((refused['allowed'], refused['layer']), (False, 'login_pair'))
            self.assertTrue(self.attempt('a@example.invalid', 2000, B)['allowed'])  # same account, another address
            self.assertTrue(self.attempt('b@example.invalid', 2000, A)['allowed'])  # same address, another account

    def test_the_address_layer_limits_rotating_accounts_from_one_address(self):
        with env(VEEVEE_RL_LOGIN_ACCOUNT='off', VEEVEE_RL_LOGIN_PAIR='off', VEEVEE_RL_LOGIN_ADDRESS='3:900,6:3600'):
            for index in range(3):
                self.assertTrue(self.attempt(f'user{index}@example.invalid', 1000 + index, A)['allowed'])
            refused = self.attempt('user9@example.invalid', 2000, A)
            self.assertEqual((refused['allowed'], refused['layer']), (False, 'login_address'))
            self.assertEqual(refused['retryAfterMs'], 1000 + 900_000 - 2000)
            self.assertTrue(self.attempt('user9@example.invalid', 2000, B)['allowed'])

    def test_a_layer_can_be_switched_off_or_retuned_independently(self):
        with env(VEEVEE_RL_LOGIN_ACCOUNT='2:60'):
            self.attempt('a@example.invalid', 1000)
            self.attempt('a@example.invalid', 1001)
            self.assertEqual(self.attempt('a@example.invalid', 1002)['retryAfterMs'], 1000 + 60_000 - 1002)
        with env(VEEVEE_RL_LOGIN_ACCOUNT='off', VEEVEE_RL_LOGIN_PAIR='off', VEEVEE_RL_LOGIN_ADDRESS='off'):
            for index in range(100):
                self.assertTrue(self.attempt('c@example.invalid', 5000 + index, A)['allowed'])

    def test_a_malformed_setting_keeps_the_default_layer_running(self):
        with env(VEEVEE_RL_LOGIN_PAIR='what-is-this'), self.assertLogs('veevee.ratelimit', level='ERROR'):
            self.assertEqual(throttle.tiers_for(throttle.PAIR, 5), throttle.DEFAULTS[throttle.PAIR])

    def test_zero_attempts_is_the_whole_login_kill_switch(self):
        result = throttle.admit('a@example.invalid', now=1, max_attempts=0, address_key=A)
        self.assertEqual(result, {'allowed': True, 'retryAfterMs': 0, 'layer': None, 'reservation': []})
        self.assertEqual(LoginAttempt.objects.count(), 0)

    def test_without_a_trusted_address_only_the_account_layer_applies(self):
        for index in range(120):
            self.assertTrue(self.attempt(f'user{index}@example.invalid', 1000 + index, None)['allowed'])
        self.assertFalse(LoginAttempt.objects.filter(identifier__startswith=('ip:')).exists())
        self.assertFalse(LoginAttempt.objects.filter(identifier__startswith=('pair:')).exists())
        for _ in range(4):
            self.attempt('user0@example.invalid', 2000, None)
        self.assertFalse(self.attempt('user0@example.invalid', 2000, None)['allowed'])

    def test_a_submitted_email_cannot_collide_with_an_address_bucket(self):
        self.assertEqual(throttle.identifier('IP:abc'), 'acct:ip:abc')
        self.assertEqual(throttle.identifier('known:x'), 'acct:known:x')
        self.assertEqual(throttle.identifier('pair:x'), 'acct:pair:x')
        self.assertEqual(throttle.identifier('acct:x'), 'acct:acct:x')
        self.assertEqual(throttle.identifier(' User@Example.invalid '), 'user@example.invalid')
        with env(VEEVEE_RL_LOGIN_ADDRESS='1:900'):
            for _ in range(5):
                self.attempt('ip:' + A, 1000)  # an attacker aiming at address A's bucket by naming it as an "email"
            self.assertTrue(self.attempt('victim@example.invalid', 2000, A)['allowed'])

    def test_a_success_forgives_the_pair_and_remembers_the_address(self):
        for offset in range(3):
            self.attempt('a@example.invalid', 1000 + offset, A)
        good = self.attempt('a@example.invalid', 2000, A)
        throttle.succeeded(good, 'a@example.invalid', now=2001, address_key=A)
        self.assertFalse(LoginAttempt.objects.filter(identifier=throttle.pair_identifier('a@example.invalid', A)).exists())
        self.assertEqual(LoginAttempt.objects.filter(identifier=throttle.known_identifier('a@example.invalid', A)).count(), 1)
        self.assertTrue(throttle.is_known('a@example.invalid', A, 3000))
        self.assertFalse(throttle.is_known('a@example.invalid', B, 3000))
        self.assertFalse(throttle.is_known('a@example.invalid', A, 2001 + throttle.KNOWN_TTL_MS))
        # The success itself is not a failure: the account bucket holds only the three earlier failures.
        self.assertEqual(LoginAttempt.objects.filter(identifier='a@example.invalid').count(), 3)

    def test_someone_else_hammering_an_account_does_not_lock_its_owner_out_from_a_known_address(self):
        owner = self.attempt('a@example.invalid', 1000, A)
        throttle.succeeded(owner, 'a@example.invalid', now=1001, address_key=A)
        for offset in range(5):
            self.assertTrue(self.attempt('a@example.invalid', 2000 + offset, B)['allowed'])
        stranger = self.attempt('a@example.invalid', 3000, B)
        self.assertEqual((stranger['allowed'], stranger['layer']), (False, 'login_account'))
        self.assertTrue(self.attempt('a@example.invalid', 3000, A)['allowed'])  # the owner at home
        self.assertFalse(self.attempt('a@example.invalid', 3000, 'c' * 32)['allowed'])  # the owner on a new network waits
        for _ in range(11):  # a thief with the password still faces the pair layer from the known address
            self.attempt('a@example.invalid', 4000, A)
        self.assertEqual(self.attempt('a@example.invalid', 4001, A)['layer'], 'login_pair')

    def test_blocked_attempts_are_counted_and_logged_once_per_window(self):
        for offset in range(5):
            self.attempt('a@example.invalid', 1000 + offset)
        with self.assertLogs('veevee.ratelimit', level='WARNING') as logs:
            for _ in range(4):
                self.attempt('a@example.invalid', 2000)
        self.assertEqual(len(logs.output), 1)
        self.assertIn('rate_limit_lockout', logs.output[0])
        self.assertNotIn('a@example.invalid', logs.output[0])
        self.assertEqual(ratelimits.event_totals(now=2000)['blocked:login_account'], (4, 4))

    def test_cleanup_keeps_rows_while_any_tier_can_still_read_them(self):
        day = 86_400_000
        throttle.record_failure('a@example.invalid', now=1000, address_key=A)
        known = throttle.known_identifier('a@example.invalid', A)
        LoginAttempt.objects.create(identifier=known, created_at=1000)
        self.assertEqual(throttle.cleanup(1000 + day), 0)  # the 24 h tier still reads it
        self.assertEqual(throttle.cleanup(1000 + day + 3_600_000), 3)
        self.assertTrue(LoginAttempt.objects.filter(identifier=known).exists())
        self.assertEqual(throttle.cleanup(1000 + throttle.KNOWN_TTL_MS), 1)

    def test_cleanup_honours_a_longer_configured_window(self):
        throttle.record_failure('a@example.invalid', now=1000)
        with env(VEEVEE_RL_LOGIN_ACCOUNT='5:604800'):
            self.assertEqual(throttle.cleanup(1000 + 2 * 86_400_000), 0)
            self.assertEqual(throttle.cleanup(1000 + 7 * 86_400_000 + 3_600_000), 1)


class MultiInstanceTests(TransactionTestCase):
    """Every API instance shares ``login_attempts``; concurrent guesses must not slip past the limit."""

    def test_concurrent_attempts_across_connections_admit_exactly_the_limit(self):
        results, errors = [], []

        def guess():
            try:
                results.append(throttle.admit('race@example.invalid', now=5_000_000, address_key=A)['allowed'])
            except Exception as error:  # surfaced by the assertion below
                errors.append(error)
            finally:
                connections.close_all()
        threads = [threading.Thread(target=guess) for _ in range(24)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(30)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 24)
        self.assertEqual(sum(results), 5)
        self.assertEqual(LoginAttempt.objects.filter(identifier='race@example.invalid').count(), 5)

    def test_concurrent_attempts_across_accounts_respect_the_address_layer(self):
        results = []

        def guess(index):
            try:
                results.append(throttle.admit(f'user{index}@example.invalid', now=5_000_000, address_key=A)['allowed'])
            finally:
                connections.close_all()
        with env(VEEVEE_RL_LOGIN_ADDRESS='7:900'):
            threads = [threading.Thread(target=guess, args=(index,)) for index in range(20)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(30)
        self.assertEqual(sum(results), 7)

    def test_a_second_instance_sees_the_first_instances_failures(self):
        for offset in range(5):
            throttle.admit('shared@example.invalid', now=1000 + offset)
        outcome = []

        def other_instance():
            try:
                outcome.append(throttle.admit('shared@example.invalid', now=2000))
            finally:
                connections.close_all()
        thread = threading.Thread(target=other_instance)
        thread.start()
        thread.join(30)
        self.assertFalse(outcome[0]['allowed'])
        self.assertEqual(outcome[0]['retryAfterMs'], 1000 + WINDOW - 2000)
