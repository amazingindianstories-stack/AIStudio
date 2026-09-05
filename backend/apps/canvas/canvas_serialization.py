"""Port of src/lib/canvas/serialization.js — defensive load/migration +
defaults for the canvas board's jsonb blob. validate_canvas_state NEVER
raises: any input, including non-dict garbage, coerces to a well-formed
CanvasState (falling back to empty_canvas_state() when there is nothing
to coerce from). This is real server-side logic — the PUT autosave route
calls it before persisting — unlike the rest of src/lib/canvas/*.js, which
is pure client-side UI math and does not need a Python port.
"""

CANVAS_STATE_VERSION = 1

NODE_TYPES = {"rect", "ellipse", "triangle", "diamond", "text", "sticky", "frame", "image"}
ANCHORS = {"auto", "top", "right", "bottom", "left", "center"}


def empty_canvas_state() -> dict:
    return {"version": CANVAS_STATE_VERSION, "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [], "connectors": []}


def _is_finite_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _str(v, fallback: str) -> str:
    return v if isinstance(v, str) else fallback


def _num(v, fallback):
    return v if _is_finite_number(v) else fallback


def _clamp01(v):
    return min(1, max(0, v))


def _validate_viewport(raw) -> dict:
    if raw is None or not isinstance(raw, dict):
        return {"x": 0, "y": 0, "zoom": 1}
    zoom = raw.get("zoom") if _is_finite_number(raw.get("zoom")) and raw.get("zoom") > 0 else 1
    return {"x": _num(raw.get("x"), 0), "y": _num(raw.get("y"), 0), "zoom": zoom}


def _validate_base(r: dict) -> dict | None:
    if not isinstance(r.get("id"), str) or not r["id"]:
        return None
    if not all(_is_finite_number(r.get(k)) for k in ("x", "y", "w", "h")):
        return None
    base = {
        "id": r["id"], "x": r["x"], "y": r["y"], "w": r["w"], "h": r["h"],
        "parentId": r.get("parentId") if isinstance(r.get("parentId"), str) else None,
        "groupId": r.get("groupId") if isinstance(r.get("groupId"), str) else None,
    }
    if _is_finite_number(r.get("opacity")):
        base["opacity"] = _clamp01(r["opacity"])
    return base


def _validate_node(raw) -> dict | None:
    if raw is None or not isinstance(raw, dict):
        return None
    node_type = raw.get("type")
    if node_type not in NODE_TYPES:
        return None
    base = _validate_base(raw)
    if not base:
        return None

    if node_type in ("rect", "ellipse", "triangle", "diamond"):
        node = {
            **base, "type": node_type,
            "fill": _str(raw.get("fill"), "#ffffff"),
            "stroke": _str(raw.get("stroke"), "#000000"),
            "strokeWidth": _num(raw.get("strokeWidth"), 1),
        }
        if node_type == "rect" and _is_finite_number(raw.get("cornerRadius")):
            node["cornerRadius"] = raw["cornerRadius"]
        return node

    if node_type == "text":
        align = raw.get("align") if raw.get("align") in ("center", "right") else "left"
        return {
            **base, "type": node_type,
            "text": _str(raw.get("text"), ""), "fontSize": _num(raw.get("fontSize"), 16),
            "align": align, "color": _str(raw.get("color"), "#000000"),
        }

    if node_type == "sticky":
        return {
            **base, "type": node_type,
            "text": _str(raw.get("text"), ""), "fill": _str(raw.get("fill"), "#fff59d"),
            "fontSize": _num(raw.get("fontSize"), 16), "color": _str(raw.get("color"), "#000000"),
        }

    if node_type == "frame":
        return {
            **base, "type": node_type,
            "name": _str(raw.get("name"), "Frame"), "fill": _str(raw.get("fill"), "transparent"),
            "stroke": _str(raw.get("stroke"), "#000000"),
        }

    if node_type == "image":
        src = _str(raw.get("src"), "")
        # Only ever our own media proxy: never embedded base64, never an
        # arbitrary external URL (a stored, auto-loading <img src> to
        # attacker infra would leak IP/UA/referrer to anyone who opens
        # the board — security review finding).
        if not src or not src.startswith("/api/media/"):
            return None
        node = {**base, "type": node_type, "src": src, "aspectLocked": raw.get("aspectLocked") is not False}
        if isinstance(raw.get("alt"), str):
            node["alt"] = raw["alt"]
        if _is_finite_number(raw.get("naturalW")):
            node["naturalW"] = raw["naturalW"]
        if _is_finite_number(raw.get("naturalH")):
            node["naturalH"] = raw["naturalH"]
        return node

    return None


def _validate_endpoint(raw, node_ids: set) -> dict | None:
    if raw is None or not isinstance(raw, dict):
        return None
    if isinstance(raw.get("nodeId"), str):
        if raw["nodeId"] not in node_ids:
            return None  # dangling reference dropped
        anchor = raw.get("anchor") if raw.get("anchor") in ANCHORS else "auto"
        return {"nodeId": raw["nodeId"], "anchor": anchor}
    if _is_finite_number(raw.get("x")) and _is_finite_number(raw.get("y")):
        return {"x": raw["x"], "y": raw["y"]}
    return None


def _validate_connector(raw, node_ids: set) -> dict | None:
    if raw is None or not isinstance(raw, dict):
        return None
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        return None
    from_ep = _validate_endpoint(raw.get("from"), node_ids)
    to_ep = _validate_endpoint(raw.get("to"), node_ids)
    if not from_ep or not to_ep:
        return None
    connector = {
        "id": raw["id"], "from": from_ep, "to": to_ep,
        "kind": "line" if raw.get("kind") == "line" else "arrow",
        "stroke": _str(raw.get("stroke"), "#000000"),
        "strokeWidth": _num(raw.get("strokeWidth"), 2),
    }
    if _is_finite_number(raw.get("opacity")):
        connector["opacity"] = _clamp01(raw["opacity"])
    return connector


def validate_canvas_state(raw) -> dict:
    if raw is None or not isinstance(raw, dict):
        return empty_canvas_state()

    viewport = _validate_viewport(raw.get("viewport"))

    nodes = []
    if isinstance(raw.get("nodes"), list):
        for n in raw["nodes"]:
            validated = _validate_node(n)
            if validated is not None:
                nodes.append(validated)

    node_ids = {n["id"] for n in nodes}
    for n in nodes:
        if n.get("parentId") and n["parentId"] not in node_ids:
            n["parentId"] = None

    connectors = []
    if isinstance(raw.get("connectors"), list):
        for c in raw["connectors"]:
            validated = _validate_connector(c, node_ids)
            if validated is not None:
                connectors.append(validated)

    return {"version": CANVAS_STATE_VERSION, "viewport": viewport, "nodes": nodes, "connectors": connectors}
