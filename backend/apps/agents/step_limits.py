"""The admin limits hook the agent runner calls before every step.

    verdict = check_limits(run, 'llm')         # or 'tool'
    if not verdict.ok:
        ...                                    # the run moves to paused_limit with verdict.reason and verdict.resume_after

Today every step is allowed. The admin limits (per-user run and step caps, the global daily cap) fill this in; a
non-ok verdict pauses the run at the step boundary, and ``resume_after`` (epoch ms, or None to wait for the artist)
is when the worker tries again.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class LimitVerdict:
    ok: bool = True
    reason: str = None
    resume_after: int = None


OK = LimitVerdict()


def check_limits(run, step_kind):
    """Whether ``run`` may take its next step, of kind ``'llm'`` or ``'tool'``."""
    return OK
