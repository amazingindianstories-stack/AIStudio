"""Format v1 sticky, tag, reaction and font fields, held to the cases the frontend serializer also runs, and
how saves treat them: the tag table travels in patches and change reads, votes are not edits, and `textBy`
follows whoever last replaced the text."""
import copy
import json
from pathlib import Path

from django.test import SimpleTestCase

from . import activity, patch
from .serialization import validate_state

FIXTURE = json.loads((Path(__file__).with_name('fixtures') / 'format_v1_stickies_tags.json').read_text())


def sticky(identifier, **fields):
    return {'id': identifier, 'type': 'sticky', 'x': 0, 'y': 0, 'w': 200, 'h': 200, 'text': '', **fields}


def board(nodes, tags=None):
    return validate_state({'nodes': nodes, **({'tags': tags} if tags is not None else {})})


class StickiesTagsSerializationTests(SimpleTestCase):
    def test_shared_cases_match_the_frontend_serializer(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                self.assertEqual(validate_state(copy.deepcopy(case['input'])), case['expected'])

    def test_validated_boards_round_trip_unchanged(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                once = validate_state(copy.deepcopy(case['expected']))
                self.assertEqual(validate_state(json.loads(json.dumps(once))), once)


class StickiesTagsSaveTests(SimpleTestCase):
    def test_a_patch_carries_the_tag_table_and_an_empty_one_removes_it(self):
        stored = board([sticky('a')], [{'id': 't', 'name': 'Idea', 'color': '#ef4444'}])
        renamed = [{'id': 't', 'name': 'Ideas', 'color': '#ef4444'}]
        self.assertEqual(validate_state(patch.apply_patch(stored, {'tags': renamed}))['tags'], renamed)
        self.assertNotIn('tags', validate_state(patch.apply_patch(stored, {'tags': []})))
        self.assertEqual(patch.apply_patch(stored, {})['tags'], stored['tags'])
        with self.assertRaises(patch.PatchError):
            patch.apply_patch(stored, {'tags': {'t': 'Idea'}})

    def test_a_tag_change_is_recorded_and_read_back_by_boards_behind(self):
        old = board([sticky('a')], [{'id': 't', 'name': 'Idea', 'color': '#ef4444'}])
        new = board([sticky('a')], [{'id': 't', 'name': 'Ideas', 'color': '#ef4444'}])
        record = patch.changed_ids(old, new)
        self.assertEqual(record, {'tags': True, 'nodes': [], 'connectors': []})
        self.assertEqual(patch.changes_since(new, [record])['tags'], new['tags'])
        self.assertNotIn('tags', patch.changes_since(new, [patch.changed_ids(old, old)]))
        # The last tag deleted reads back as an empty table.
        self.assertEqual(patch.changes_since(board([sticky('a')]), [patch.changed_ids(old, board([sticky('a')]))])['tags'], [])

    def test_votes_keep_stamps_and_record_nothing(self):
        old = board([sticky('a', text='hi', createdBy='1', createdAt=1, updatedBy='1', updatedAt=1, textBy='1')])
        voted = board([sticky('a', text='hi', reactions={'👍': ['2']})])
        stamped, changes = activity.stamp(old, voted, '2', 9)
        self.assertEqual(changes, [])
        self.assertEqual({key: stamped['nodes'][0][key] for key in ('updatedBy', 'textBy')}, {'updatedBy': '1', 'textBy': '1'})

    def test_text_by_follows_the_text_and_not_other_edits(self):
        old = board([sticky('a', text='hi', createdBy='1', createdAt=1, updatedBy='1', updatedAt=1, textBy='1')])
        recolored, _ = activity.stamp(old, board([sticky('a', text='hi', fill='#ffffff')]), '2', 9)
        self.assertEqual((recolored['nodes'][0]['updatedBy'], recolored['nodes'][0]['textBy']), ('2', '1'))
        retyped, changes = activity.stamp(old, board([sticky('a', text='new')]), '3', 9)
        self.assertEqual((retyped['nodes'][0]['textBy'], changes[0][0]), ('3', 'edit'))
        # A new object's text is its creator's, so it carries no textBy.
        added, _ = activity.stamp(board([]), board([sticky('b', text='x')]), '4', 9)
        self.assertEqual((added['nodes'][0]['createdBy'], 'textBy' in added['nodes'][0]), ('4', False))
