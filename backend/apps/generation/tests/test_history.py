import time
import uuid

from django.http import QueryDict
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common.test_utils import SECRET, _cookie_for, _make_user

from .. import generations_service as gs
from ..history_query import MAX_QUERY_LENGTH, parse_history_filter
from ..models import Generation


def _parse(qs: str) -> dict:
    return parse_history_filter(QueryDict(qs))


class DecodeCursorTests(TestCase):
    def test_valid_cursor_round_trips(self):
        encoded = gs.encode_cursor(1700000000000, "d4d378ea-6ceb-4451-912d-1fc3a0ab637a")
        self.assertEqual(gs.decode_cursor(encoded), (1700000000000, "d4d378ea-6ceb-4451-912d-1fc3a0ab637a"))

    def test_none_and_empty_rejected(self):
        self.assertIsNone(gs.decode_cursor(None))
        self.assertIsNone(gs.decode_cursor(""))

    def test_malformed_rejected_not_raised(self):
        """A junk cursor must degrade to 'first page', never a 500 from a
        predicate built out of an unparseable value."""
        self.assertIsNone(gs.decode_cursor("no-dot-here"))
        self.assertIsNone(gs.decode_cursor("notanumber.d4d378ea-6ceb-4451-912d-1fc3a0ab637a"))
        self.assertIsNone(gs.decode_cursor("123.not-a-uuid"))


class LikePatternTests(TestCase):
    def test_escapes_metacharacters(self):
        self.assertEqual(gs.like_pattern("50%_off"), "%50\\%\\_off%")

    def test_escapes_backslash(self):
        self.assertEqual(gs.like_pattern("a\\b"), "%a\\\\b%")


class ParseHistoryFilterTests(TestCase):
    """Port of the parser half of src/lib/history-query.test.js — the
    `*FilterToParams` builder stays frontend-only (querystring construction
    for the client fetch), same reasoning as admin-logs.js's equivalent. This
    parser had zero test coverage on either side of the split before now."""

    def test_empty_querystring_is_empty_filter(self):
        self.assertEqual(_parse(""), {})

    def test_project_id_read_through(self):
        self.assertEqual(_parse("projectId=p1"), {"projectId": "p1"})

    def test_folder_id_none_maps_to_explicit_null(self):
        filter = _parse("folderId=none")
        self.assertIn("folderId", filter)
        self.assertIsNone(filter["folderId"])

    def test_absent_folder_id_means_any_folder_not_present_at_all(self):
        self.assertNotIn("folderId", _parse(""))

    def test_real_folder_id_read_through_distinct_from_none(self):
        self.assertEqual(_parse("folderId=f1"), {"folderId": "f1"})

    def test_kind_accepts_only_image_or_video(self):
        self.assertEqual(_parse("kind=image")["kind"], "image")
        self.assertEqual(_parse("kind=video")["kind"], "video")
        self.assertNotIn("kind", _parse("kind=all"))
        self.assertNotIn("kind", _parse("kind=bogus"))

    def test_favorite_true_only_for_literal_1(self):
        self.assertEqual(_parse("favorite=1")["favorite"], True)
        self.assertNotIn("favorite", _parse("favorite=true"))
        self.assertNotIn("favorite", _parse("favorite=0"))
        self.assertNotIn("favorite", _parse(""))

    def test_q_is_trimmed(self):
        self.assertEqual(_parse("q=%20%20hello%20%20")["q"], "hello")

    def test_whitespace_only_q_is_dropped(self):
        self.assertNotIn("q", _parse("q=%20%20%20"))

    def test_q_truncated_to_max_query_length(self):
        long = "x" * (MAX_QUERY_LENGTH + 500)
        self.assertEqual(len(_parse(f"q={long}")["q"]), MAX_QUERY_LENGTH)


def _make_generation(**overrides) -> Generation:
    now = int(time.time() * 1000)
    defaults = dict(
        id=uuid.uuid4(), kind="image", status="succeeded", prompt="test prompt",
        model="m", aspect_ratio="1:1", created_at=now, updated_at=now,
    )
    defaults.update(overrides)
    return Generation.objects.create(**defaults)


class QueryHistoryTests(TestCase):
    def test_keyset_pagination_no_skip_no_duplicate(self):
        base = 1_700_000_000_000
        made = [_make_generation(created_at=base + i, updated_at=base + i) for i in range(7)]
        made_ids = {str(g.id) for g in made}

        seen: list[str] = []
        cursor = None
        for _ in range(10):  # bounded so a bug can't infinite-loop the test
            page = gs.query_history({}, cursor, limit_n=3)
            page_ids = [i["id"] for i in page["items"] if i["id"] in made_ids]
            seen.extend(page_ids)
            if not page["nextCursor"]:
                break
            cursor = gs.decode_cursor(page["nextCursor"])

        self.assertEqual(len(seen), len(set(seen)))  # no duplicates
        self.assertEqual(set(seen), made_ids)  # nothing skipped

    def test_folder_filter_none_means_unsorted(self):
        now = int(time.time() * 1000)
        project_id = uuid.uuid4()
        folder_id = uuid.uuid4()
        in_folder = _make_generation(project_id=project_id, folder_id=folder_id)
        unsorted_item = _make_generation(project_id=project_id, folder_id=None)

        page = gs.query_history({"projectId": str(project_id), "folderId": None}, limit_n=20)
        ids = {i["id"] for i in page["items"]}
        self.assertIn(str(unsorted_item.id), ids)
        self.assertNotIn(str(in_folder.id), ids)

    def test_favorites_sort_by_favorited_at_not_created_at(self):
        older_favorite = _make_generation(is_favorite=True, favorited_at=2_000_000_000_000, created_at=1_000_000_000_000)
        newer_favorite = _make_generation(is_favorite=True, favorited_at=3_000_000_000_000, created_at=1_100_000_000_000)

        page = gs.query_history({"favorite": True}, limit_n=20)
        ids_in_order = [i["id"] for i in page["items"]]
        self.assertLess(
            ids_in_order.index(str(newer_favorite.id)), ids_in_order.index(str(older_favorite.id))
        )

    def test_prompt_search_is_case_insensitive_substring(self):
        target = _make_generation(prompt="A Dragon flies over the Castle")
        _make_generation(prompt="unrelated prompt")

        page = gs.query_history({"q": "dragon"}, limit_n=20)
        ids = {i["id"] for i in page["items"]}
        self.assertIn(str(target.id), ids)
        self.assertEqual(len(page["items"]), 1)


class CountHistoryTests(TestCase):
    def test_groups_by_folder_and_totals(self):
        project_id = uuid.uuid4()
        folder_a = uuid.uuid4()
        folder_b = uuid.uuid4()
        _make_generation(project_id=project_id, folder_id=folder_a)
        _make_generation(project_id=project_id, folder_id=folder_a)
        _make_generation(project_id=project_id, folder_id=folder_b)
        _make_generation(project_id=project_id, folder_id=None)

        counts = gs.count_history({"projectId": str(project_id)})
        self.assertEqual(counts["total"], 4)
        self.assertEqual(counts["unsorted"], 1)
        self.assertEqual(counts["byFolder"][str(folder_a)], 2)
        self.assertEqual(counts["byFolder"][str(folder_b)], 1)


class ReadGenerationUpdatesTests(TestCase):
    def test_includes_in_flight_regardless_of_updated_at(self):
        """A job that just got created (status=queued) has updated_at close
        to `now`, but a pure `updated_at > since` filter with a `since`
        set to right now would still miss it — the OR on status is what
        the TS docstring calls out as load-bearing."""
        now = int(time.time() * 1000)
        running = _make_generation(status="running", created_at=now, updated_at=now)
        finished_long_ago = _make_generation(status="succeeded", created_at=now - 1_000_000, updated_at=now - 1_000_000)

        updates = gs.read_generation_updates(since=now + 10_000)  # "since" is in the future
        ids = {i["id"] for i in updates}
        self.assertIn(str(running.id), ids)
        self.assertNotIn(str(finished_long_ago.id), ids)

    def test_no_duplicate_when_row_matches_both_conditions(self):
        now = int(time.time() * 1000)
        row = _make_generation(status="running", created_at=now, updated_at=now)
        updates = gs.read_generation_updates(since=now - 1000)
        matching = [i for i in updates if i["id"] == str(row.id)]
        self.assertEqual(len(matching), 1)


@override_settings(AUTH_SECRET=SECRET)
class HistoryRouteAuthTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_history_requires_auth(self):
        self.assertEqual(self.client.get("/api/history").status_code, 401)

    def test_history_counts_requires_auth(self):
        self.assertEqual(self.client.get("/api/history/counts").status_code, 401)

    def test_history_updates_requires_auth(self):
        self.assertEqual(self.client.get("/api/history/updates").status_code, 401)

    def test_download_zip_requires_auth(self):
        self.assertEqual(self.client.post("/api/history/download-zip", {"ids": []}, format="json").status_code, 401)

    def test_download_zip_requires_ids(self):
        user = _make_user()
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.post("/api/history/download-zip", {"ids": []}, format="json")
        self.assertEqual(resp.status_code, 400)
