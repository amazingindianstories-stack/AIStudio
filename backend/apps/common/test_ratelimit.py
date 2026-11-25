"""Tier parsing, environment resolution and the exact Retry-After arithmetic."""
import logging

from django.test import SimpleTestCase

from apps.common.ratelimit import Tier, evaluate, parse_tiers, tiers_from_env

DEFAULT = (Tier(5, 900),)


class ParseTests(SimpleTestCase):
    def test_tiers_are_sorted_shortest_window_first(self):
        self.assertEqual(parse_tiers('20:86400, 5:900,10:3600'), (Tier(5, 900), Tier(10, 3600), Tier(20, 86400)))

    def test_malformed_values_are_rejected(self):
        for raw in ('', 'x', '5', '5:', ':900', '0:900', '5:0', '-1:900', '5:900,6:900', '5:900,,6:60', '1.5:60',
                    '5:99999999', '9999999:60', ','.join(f'{n}:{n * 60}' for n in range(1, 8))):
            with self.assertRaises(ValueError, msg=raw):
                parse_tiers(raw)


class EnvironmentTests(SimpleTestCase):
    def test_unset_uses_the_default_and_off_or_empty_switches_the_layer_off(self):
        self.assertEqual(tiers_from_env('VEEVEE_RL_X', DEFAULT, env={}), DEFAULT)
        for raw in ('off', 'OFF', ' off ', '', '  '):
            self.assertEqual(tiers_from_env('VEEVEE_RL_X', DEFAULT, env={'VEEVEE_RL_X': raw}), ())

    def test_a_valid_value_replaces_the_default(self):
        self.assertEqual(tiers_from_env('VEEVEE_RL_X', DEFAULT, env={'VEEVEE_RL_X': '3:60,9:600'}), (Tier(3, 60), Tier(9, 600)))

    def test_a_malformed_value_falls_back_to_the_default_and_is_logged(self):
        with self.assertLogs('veevee.ratelimit', level=logging.ERROR) as logs:
            self.assertEqual(tiers_from_env('VEEVEE_RL_BAD', DEFAULT, env={'VEEVEE_RL_BAD': 'nonsense-1'}), DEFAULT)
        self.assertIn('ratelimit_config_invalid', logs.output[0])
        self.assertIn('VEEVEE_RL_BAD', logs.output[0])


class EvaluateTests(SimpleTestCase):
    def test_under_the_limit_is_admitted(self):
        self.assertEqual(evaluate([1000, 2000, 3000, 4000], (Tier(5, 900),), 5000), (0, None))
        self.assertEqual(evaluate([], (Tier(5, 900),), 5000), (0, None))

    def test_at_the_limit_waits_until_the_oldest_event_leaves_the_window(self):
        tier = Tier(5, 900)
        stamps = [1000, 2000, 3000, 4000, 5000]
        self.assertEqual(evaluate(stamps, (tier,), 6000), (1000 + 900_000 - 6000, tier))

    def test_over_the_limit_waits_for_enough_events_to_expire(self):
        # Seven events against a limit of five: the next is admitted once only four remain in the window, i.e. after
        # the third oldest has expired.
        tier = Tier(5, 900)
        stamps = [1000, 2000, 3000, 4000, 5000, 6000, 7000]
        self.assertEqual(evaluate(stamps, (tier,), 8000), (3000 + 900_000 - 8000, tier))

    def test_events_outside_the_window_do_not_count(self):
        tier = Tier(2, 60)
        self.assertEqual(evaluate([0, 1000], (tier,), 61_000), (0, None))
        self.assertEqual(evaluate([0, 1000], (tier,), 59_999)[0], 1)
        self.assertEqual(evaluate([0, 1000], (tier,), 60_000), (0, None))

    def test_the_longest_wait_among_the_tiers_wins_and_names_its_tier(self):
        short, long = Tier(5, 900), Tier(6, 3600)
        stamps = [0, 1000, 2000, 3000, 4000, 1_000_000]
        # Only the last event is inside the 15-minute window, but the hour holds all six.
        wait, tier = evaluate(stamps, (short, long), 1_001_000)
        self.assertEqual((wait, tier), (0 + 3_600_000 - 1_001_000, long))
        wait, tier = evaluate(stamps[:5], (short, long), 5000)
        self.assertEqual((wait, tier), (900_000 - 5000, short))

    def test_the_wait_is_exactly_the_moment_the_next_attempt_is_admitted(self):
        tier = Tier(3, 600)
        stamps = [100, 200, 300, 400]
        now = 500
        wait, _ = evaluate(stamps, (tier,), now)
        self.assertGreater(wait, 0)
        self.assertEqual(evaluate(stamps, (tier,), now + wait - 1)[0], 1)
        self.assertEqual(evaluate(stamps, (tier,), now + wait), (0, None))
