"""Port of src/lib/middleware/face-judge.js — Gemini-as-judge for face
identity (server-only). See that file's header: validated in
scripts/ab-face-eval.js, judging N candidates and keeping the best beats
any single-pass prompt trick because generation is stochastic."""

import json
import os

import requests

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"


def _extract_text(data: dict) -> str | None:
    parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts") or []
    return next((p["text"] for p in parts if isinstance(p.get("text"), str)), None)


def judge_identity(ref_face: dict, candidate: dict) -> float | None:
    """0-100 identity score, or None when judging is unavailable
    (fail-open). ref_face/candidate: {"mimeType", "data"}."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    model = os.environ.get("GEMINI_DETECT_MODEL", "gemini-2.5-flash")
    try:
        res = requests.post(
            f"{API_ROOT}/models/{model}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json={
                "contents": [{
                    "role": "user",
                    "parts": [
                        {"text": "IMAGE 1 — ground-truth reference face of a specific person:"},
                        {"inlineData": {"mimeType": ref_face["mimeType"], "data": ref_face["data"]}},
                        {"text": "IMAGE 2 — a generated cinematic frame whose main character is supposed to be that exact person:"},
                        {"inlineData": {"mimeType": candidate["mimeType"], "data": candidate["data"]}},
                        {"text": (
                            "Compare the main character's face in IMAGE 2 to IMAGE 1 "
                            "like a forensic examiner: bone structure, jawline, eye "
                            "shape/spacing, eyebrows, nose, lips, face shape, apparent "
                            'age. Answer JSON: {"identity": 0-100} where 100 = '
                            "unmistakably the SAME person, 50 = related-looking, "
                            "0 = a different person."
                        )},
                    ],
                }],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
            },
            timeout=30,
        )
        if not res.ok:
            return None
        text = _extract_text(res.json())
        score = float(json.loads(text).get("identity"))
        return max(0.0, min(100.0, score)) if score == score else None  # score==score rules out NaN
    except Exception:
        return None


def judge_candidate(ref_face: dict, candidate: dict) -> dict | None:
    """One extended call scoring identity + prominence + sharpness. Returns
    {"identity", "prominence", "sharpness"} or None (fail-open)."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    model = os.environ.get("GEMINI_DETECT_MODEL", "gemini-2.5-flash")
    try:
        res = requests.post(
            f"{API_ROOT}/models/{model}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json={
                "contents": [{
                    "role": "user",
                    "parts": [
                        {"text": "IMAGE 1 — ground-truth reference face of a specific person:"},
                        {"inlineData": {"mimeType": ref_face["mimeType"], "data": ref_face["data"]}},
                        {"text": "IMAGE 2 — a generated cinematic frame whose main character is supposed to be that exact person:"},
                        {"inlineData": {"mimeType": candidate["mimeType"], "data": candidate["data"]}},
                        {"text": (
                            "Score IMAGE 2 on three axes and answer JSON: "
                            '{"identity": 0-100, "prominence": 0-100, "sharpness": 0-100}. '
                            '"identity": compare the main character\'s face in IMAGE 2 to IMAGE 1 '
                            "like a forensic examiner — bone structure, jawline, eye shape/spacing, "
                            "eyebrows, nose, lips, face shape, apparent age; 100 = unmistakably the "
                            "SAME person, 50 = related-looking, 0 = a different person. "
                            '"prominence": how large, near-camera and centered the main subject\'s '
                            "face is within IMAGE 2's frame; 100 = a large, clearly framed hero "
                            "subject, 0 = tiny/distant/barely visible. "
                            '"sharpness": how crisp and in-focus the main subject\'s FACE region '
                            "specifically is (not the whole frame — ignore background blur/grain); "
                            "100 = tack sharp facial detail, 0 = soft/blurred/smeared face."
                        )},
                    ],
                }],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
            },
            timeout=30,
        )
        if not res.ok:
            return None
        text = _extract_text(res.json())
        parsed = json.loads(text)

        def clamp(v) -> float | None:
            try:
                n = float(v)
            except (TypeError, ValueError):
                return None
            return max(0.0, min(100.0, n)) if n == n else None

        identity = clamp(parsed.get("identity"))
        prominence = clamp(parsed.get("prominence"))
        sharpness = clamp(parsed.get("sharpness"))
        if identity is None or prominence is None or sharpness is None:
            return None
        return {"identity": identity, "prominence": prominence, "sharpness": sharpness}
    except Exception:
        return None


def select_best_candidate(scores: list[dict | None], slack: int = 8) -> int:
    """Pure selector. Among candidates whose identity is within `slack` of
    the max identity (the identity FLOOR), choose the highest composite =
    prominence + sharpness. Ties break toward higher identity, then lower
    index. Nulls score as -1 and are only picked if all are null."""

    def identity_of(s: dict | None) -> float:
        return s["identity"] if s else -1

    max_identity = max((identity_of(s) for s in scores), default=-1)

    if max_identity == -1:
        return 0

    best = -1
    for i, s in enumerate(scores):
        if not s:
            continue
        if s["identity"] < max_identity - slack:
            continue

        if best == -1:
            best = i
            continue
        best_score = scores[best]
        composite = s["prominence"] + s["sharpness"]
        best_composite = best_score["prominence"] + best_score["sharpness"]
        if composite > best_composite or (composite == best_composite and s["identity"] > best_score["identity"]):
            best = i
    return 0 if best == -1 else best
