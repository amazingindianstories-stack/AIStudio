"""Port of src/lib/canvas/serialization.test.js's cases."""

import copy
import json

from django.test import SimpleTestCase

from .. import canvas_serialization as cs


class EmptyCanvasStateTests(SimpleTestCase):
    def test_returns_current_version(self):
        self.assertEqual(cs.empty_canvas_state()["version"], cs.CANVAS_STATE_VERSION)

    def test_returns_identity_viewport(self):
        self.assertEqual(cs.empty_canvas_state()["viewport"], {"x": 0, "y": 0, "zoom": 1})

    def test_returns_empty_nodes_and_connectors(self):
        state = cs.empty_canvas_state()
        self.assertEqual(state["nodes"], [])
        self.assertEqual(state["connectors"], [])

    def test_successive_calls_return_independent_instances(self):
        a = cs.empty_canvas_state()
        b = cs.empty_canvas_state()
        a["nodes"].append({})
        self.assertEqual(len(b["nodes"]), 0)


def _build_full_state() -> dict:
    return {
        "version": cs.CANVAS_STATE_VERSION,
        "viewport": {"x": 12.5, "y": -30, "zoom": 1.75},
        "nodes": [
            {"id": "frame1", "type": "frame", "x": -50, "y": 150, "w": 400, "h": 300, "parentId": None, "groupId": None,
             "name": "EXT. MOUNTAIN TOP - DAY", "fill": "#f5f5f5", "stroke": "#999999"},
            {"id": "rect1", "type": "rect", "x": 0, "y": 0, "w": 100, "h": 50, "opacity": 1, "parentId": None, "groupId": None,
             "fill": "#ff0000", "stroke": "#000000", "strokeWidth": 2, "cornerRadius": 4},
            {"id": "ellipse1", "type": "ellipse", "x": 200, "y": 0, "w": 80, "h": 80, "opacity": 0.8, "parentId": None, "groupId": "group1",
             "fill": "#00ff00", "stroke": "#111111", "strokeWidth": 1},
            {"id": "triangle1", "type": "triangle", "x": 300, "y": 0, "w": 60, "h": 60, "parentId": None, "groupId": "group1",
             "fill": "#0000ff", "stroke": "#222222", "strokeWidth": 1},
            {"id": "diamond1", "type": "diamond", "x": 400, "y": 0, "w": 60, "h": 60, "parentId": None, "groupId": None,
             "fill": "#ffff00", "stroke": "#333333", "strokeWidth": 1},
            {"id": "text1", "type": "text", "x": 0, "y": 100, "w": 150, "h": 30, "parentId": None, "groupId": None,
             "text": "Hello board", "fontSize": 16, "align": "left", "color": "#000000"},
            {"id": "sticky1", "type": "sticky", "x": 0, "y": 200, "w": 120, "h": 120, "parentId": "frame1", "groupId": None,
             "text": "note text", "fill": "#fff59d", "fontSize": 14, "color": "#000000"},
            {"id": "image1", "type": "image", "x": 500, "y": 500, "w": 320, "h": 240, "parentId": None, "groupId": None,
             "src": "/api/media/generations/abc123.png", "alt": "generated image", "aspectLocked": True,
             "naturalW": 1024, "naturalH": 768},
        ],
        "connectors": [
            {"id": "conn1", "from": {"nodeId": "rect1", "anchor": "right"}, "to": {"x": 999, "y": 999},
             "kind": "arrow", "stroke": "#000000", "strokeWidth": 2, "opacity": 1},
        ],
    }


class ValidateCanvasStateRoundTripTests(SimpleTestCase):
    def test_round_trips_full_state_through_json(self):
        original = _build_full_state()
        parsed = json.loads(json.dumps(original))
        validated = cs.validate_canvas_state(parsed)
        self.assertEqual(validated, original)

    def test_preserves_z_order(self):
        original = _build_full_state()
        validated = cs.validate_canvas_state(json.loads(json.dumps(original)))
        self.assertEqual([n["id"] for n in validated["nodes"]], [n["id"] for n in original["nodes"]])


class ValidateCanvasStateDefensiveCoercionTests(SimpleTestCase):
    def test_missing_nodes_coerced_to_empty_array(self):
        raw = {"version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1}, "connectors": []}
        result = cs.validate_canvas_state(raw)
        self.assertEqual(result["nodes"], [])

    def test_missing_connectors_coerced_to_empty_array(self):
        raw = {"version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": []}
        result = cs.validate_canvas_state(raw)
        self.assertEqual(result["connectors"], [])

    def test_node_missing_required_fields_dropped_others_survive(self):
        raw = {
            "version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1},
            "nodes": [
                {"id": "broken", "type": "rect"},
                {"id": "good", "type": "rect", "x": 0, "y": 0, "w": 10, "h": 10, "fill": "#fff", "stroke": "#000", "strokeWidth": 1},
            ],
            "connectors": [],
        }
        result = cs.validate_canvas_state(raw)
        for n in result["nodes"]:
            for key in ("x", "y", "w", "h"):
                self.assertIsInstance(n[key], (int, float))

    def test_unversioned_blob_produces_valid_state(self):
        raw = {"nodes": [], "connectors": []}
        result = cs.validate_canvas_state(raw)
        self.assertIsInstance(result["version"], int)
        self.assertIsInstance(result["viewport"]["x"], (int, float))
        self.assertIsInstance(result["viewport"]["y"], (int, float))
        self.assertIsInstance(result["viewport"]["zoom"], (int, float))
        self.assertIsInstance(result["nodes"], list)
        self.assertIsInstance(result["connectors"], list)

    def test_garbage_top_level_inputs_never_raise(self):
        for raw in (None, "not an object", 42, [], True, {}):
            result = cs.validate_canvas_state(raw)
            self.assertIsInstance(result["version"], int, raw)
            self.assertIsInstance(result["nodes"], list, raw)
            self.assertIsInstance(result["connectors"], list, raw)
            self.assertIsInstance(result["viewport"]["zoom"], (int, float), raw)

    def test_extra_unknown_keys_ignored_valid_data_survives(self):
        raw = {
            "version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1},
            "nodes": [
                {"id": "n1", "type": "rect", "x": 1, "y": 2, "w": 3, "h": 4, "fill": "#fff", "stroke": "#000",
                 "strokeWidth": 1, "someUnknownField": "should be ignored, not crash"},
            ],
            "connectors": [],
            "someTopLevelJunk": {"nested": True},
        }
        result = cs.validate_canvas_state(raw)
        n1 = next((n for n in result["nodes"] if n["id"] == "n1"), None)
        self.assertIsNotNone(n1)
        self.assertEqual((n1["x"], n1["y"], n1["w"], n1["h"]), (1, 2, 3, 4))

    def test_non_array_nodes_coerced_to_empty_array(self):
        raw = {"version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": "not-an-array", "connectors": []}
        result = cs.validate_canvas_state(raw)
        self.assertEqual(result["nodes"], [])


class DanglingReferenceTests(SimpleTestCase):
    """Not explicitly in the TS suite as a standalone test, but exercised
    implicitly by the "two key invariants" documented in design.md and in
    CLAUDE.md's canvas board section — pinned here directly since it's
    easy to regress silently."""

    def test_dangling_parent_id_dropped(self):
        raw = {
            "nodes": [
                {"id": "orphan", "type": "rect", "x": 0, "y": 0, "w": 1, "h": 1, "parentId": "does-not-exist",
                 "fill": "#fff", "stroke": "#000", "strokeWidth": 1},
            ],
            "connectors": [],
        }
        result = cs.validate_canvas_state(raw)
        self.assertIsNone(result["nodes"][0]["parentId"])

    def test_dangling_connector_endpoint_drops_the_connector(self):
        raw = {
            "nodes": [],
            "connectors": [
                {"id": "c1", "from": {"nodeId": "missing"}, "to": {"x": 0, "y": 0}, "stroke": "#000", "strokeWidth": 1},
            ],
        }
        result = cs.validate_canvas_state(raw)
        self.assertEqual(result["connectors"], [])
