"""Port of src/lib/select-candidate.test.js's cases (selectBestCandidate)."""

from django.test import SimpleTestCase

from .. import face_judge as fj


def score(identity, prominence, sharpness):
    return {"identity": identity, "prominence": prominence, "sharpness": sharpness}


class SelectBestCandidateTests(SimpleTestCase):
    def test_identity_floor_honored_lower_identity_within_slack_wins_on_composite(self):
        scores = [score(90, 10, 10), score(85, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 1)

    def test_floor_excludes_high_composite_beyond_slack(self):
        scores = [score(90, 10, 10), score(70, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 0)

    def test_all_null_returns_index_0(self):
        self.assertEqual(fj.select_best_candidate([None, None, None]), 0)

    def test_single_null_array_returns_0(self):
        self.assertEqual(fj.select_best_candidate([None]), 0)

    def test_mixed_null_and_scored_ignores_nulls(self):
        scores = [None, score(80, 50, 50), score(60, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 1)

    def test_null_never_chosen_over_real_even_at_index_0(self):
        scores = [None, score(40, 5, 5)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 1)

    def test_composite_tie_breaks_toward_higher_identity(self):
        scores = [score(80, 50, 40), score(85, 40, 50)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 1)

    def test_full_tie_breaks_toward_lower_index(self):
        scores = [score(80, 50, 40), score(80, 50, 40)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 0)

    def test_identity_exactly_at_floor_boundary_included(self):
        scores = [score(90, 10, 10), score(82, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 1)

    def test_identity_one_point_beyond_boundary_excluded(self):
        scores = [score(90, 10, 10), score(81, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 0)

    def test_default_slack_behaves_as_8(self):
        scores = [score(90, 10, 10), score(85, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores), 1)

    def test_slack_0_requires_exact_identity_match(self):
        scores = [score(90, 10, 10), score(89, 99, 99)]
        self.assertEqual(fj.select_best_candidate(scores, 0), 0)

    def test_three_way_field(self):
        scores = [score(95, 20, 20), score(90, 60, 60), score(50, 100, 100)]
        self.assertEqual(fj.select_best_candidate(scores, 8), 1)
