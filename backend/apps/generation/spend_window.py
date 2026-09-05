"""Direct port of src/lib/spend-window.js — spend-aware admission control
for Gemini-backed generations. Read that file's header before touching any
constant here: DEFAULT_SPEND_LIMIT_CENTS is derived from a measured
incident (2026-07-28), not from Tier 1's nominal $10 — see the TS docstring
for the full derivation. Do not "correct" it upward."""

import os

SPEND_WINDOW_MS = 10 * 60 * 1000

DEFAULT_SPEND_LIMIT_CENTS = 150


def _positive_int(raw: str | None, fallback: int) -> int:
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return fallback
    return int(n) if n > 0 else fallback


def spend_limit_cents(env: dict | None = None) -> int:
    env = env if env is not None else os.environ
    raw = env.get("GEMINI_SPEND_LIMIT_CENTS")
    if raw is not None:
        try:
            if float(raw) == 0:
                return 0  # explicit opt-out
        except ValueError:
            pass
    return _positive_int(raw, DEFAULT_SPEND_LIMIT_CENTS)


def best_of_multiplier(env: dict | None = None) -> int:
    """Best-of-N fans out N parallel renders per delivered image, so an
    image job's true API spend is N× its stored cost_cents. Mirrors the
    clamp in queue/execute so the two cannot drift."""
    env = env if env is not None else os.environ
    try:
        n = int(env.get("FACE_BEST_OF") or 2)
    except ValueError:
        n = 2
    # Mirrors TS's `Number(env.FACE_BEST_OF) || 2` — 0 is falsy in JS, so an
    # explicit "0" falls back to the default rather than clamping to 1.
    if not n:
        n = 2
    return min(4, max(1, n))


def admits(window_cents: int, job_cents: int, limit_cents: int, window_busy: bool) -> bool:
    """The window_busy escape is a forward-progress guarantee: without it,
    a single job whose own estimate exceeds the whole budget would be held
    forever, because the window can never drain below its own cost. An
    empty window means nothing else is in flight, so letting it through
    risks at most that one job's spend."""
    if limit_cents <= 0:
        return True  # gate disabled
    if not window_busy:
        return True  # forward-progress guarantee
    return window_cents + job_cents <= limit_cents


def hold_retry_after_ms(oldest_updated_at: int | None, now: int) -> int:
    """Spend leaves the window exactly SPEND_WINDOW_MS after the row that
    incurred it was last touched, so the oldest in-window row is the
    soonest moment more budget exists. Floored at 5s so a client can't
    busy-poll, capped at the window length so a clock skew can't strand it."""
    if oldest_updated_at is None:
        return 5_000
    frees_at = oldest_updated_at + SPEND_WINDOW_MS
    return min(max(frees_at - now, 5_000), SPEND_WINDOW_MS)


HELD_MESSAGE = "Waiting for the API rate-limit window to clear — this will start automatically."
