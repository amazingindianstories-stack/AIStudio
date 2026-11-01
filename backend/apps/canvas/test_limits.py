"""Per-board plan limits (apps.canvas.limits): refuse growth past a limit, never block trimming."""
from django.test import SimpleTestCase

from . import limits
from .serialization import validate_state


def node(identifier, kind='sticky', text=''):
    return {'id': identifier, 'type': kind, 'x': 0, 'y': 0, 'w': 100, 'h': 100, 'text': text}


def board(nodes):
    return validate_state({'nodes': nodes})


class BoardLimitTests(SimpleTestCase):
    def test_a_board_may_reach_the_object_limit_and_not_pass_it(self):
        full = board([node(f'n{i}', 'rect') for i in range(limits.MAX_BOARD_OBJECTS)])
        limits.enforce(board([]), full)
        over = board([*full['nodes'], node('extra', 'rect')])
        with self.assertRaises(limits.BoardLimitExceeded) as raised:
            limits.enforce(full, over)
        self.assertEqual(raised.exception.code, 'objects')
        self.assertNotIn('—', raised.exception.message)

    def test_a_board_already_over_the_limit_can_still_shrink_or_stay_the_same(self):
        big = board([node(f'n{i}', 'rect') for i in range(limits.MAX_BOARD_OBJECTS + 3)])
        limits.enforce(big, big)
        limits.enforce(big, board(big['nodes'][:-1]))

    def test_sticky_text_is_capped_in_utf16_units(self):
        at_cap = board([node('a', text='x' * 3000)])
        limits.enforce(board([]), at_cap)
        with self.assertRaises(limits.BoardLimitExceeded) as raised:
            limits.enforce(board([]), board([node('a', text='x' * 3001)]))
        self.assertEqual(raised.exception.code, 'text')
        # An emoji is two UTF-16 units.
        with self.assertRaises(limits.BoardLimitExceeded):
            limits.enforce(board([]), board([node('a', text='\U0001F600' * 1501)]))

    def test_an_oversized_text_may_be_shortened_or_left_alone_but_not_extended(self):
        long = board([node('a', text='x' * 3500)])
        limits.enforce(long, long)
        limits.enforce(long, board([node('a', text='x' * 3200)]))
        with self.assertRaises(limits.BoardLimitExceeded):
            limits.enforce(long, board([node('a', text='x' * 3600)]))

    def test_types_without_a_text_cap_are_unbounded(self):
        limits.enforce(board([]), board([{'id': 'f', 'type': 'frame', 'x': 0, 'y': 0, 'w': 1, 'h': 1, 'name': 'y' * 9000}]))
