"""Waiting for a generation (or a ZIP export) inside one tool call without holding a thread.

The hold polls the indexed row on ``asyncio.sleep``: every second for the first 10 s, then every 2 s, until the job is
terminal or the call's wait budget is spent. The budget is measured from the start of the call and capped by
``MCP_MAX_HOLD_SECONDS``. Each waiting call takes one of the token's hold slots; when none is free the call returns at
once with a note. A client that disconnects only stops the waiting; the work itself is never cancelled.
"""
import asyncio
import time
from contextlib import asynccontextmanager

from django.conf import settings

from apps.generation.models import Generation
from apps.mcp_auth import controls, policy
from .results import TERMINAL
from .runtime import db

FAST_POLL_SECONDS, SLOW_POLL_SECONDS, FAST_PHASE_SECONDS = 1.0, 2.0, 10.0
BUSY_NOTE = (f'This connection already has {policy.HOLDS_PER_TOKEN} calls waiting, so this one returned at once. '
             'Call get_generation with wait=true once one of them returns.')


def wait_seconds(max_wait_seconds=None):
    """The wait a call asked for, defaulting to and capped by MCP_MAX_HOLD_SECONDS, counted from the call's start."""
    cap = settings.MCP_MAX_HOLD_SECONDS
    return cap if max_wait_seconds is None else min(max_wait_seconds, cap)


@asynccontextmanager
async def hold_slot(principal):
    """One of the token's hold slots, or None when all are taken; released even when the client goes away."""
    slot = controls.hold_slot(principal)
    try:
        await db(slot.__enter__)
    except controls.ConcurrencyLimit:
        yield None
        return
    try:
        yield slot
    finally:
        try:
            await asyncio.shield(db(slot.__exit__, None, None, None))
        except Exception:
            pass                    # an unreleased slot expires after policy.HOLD_TTL_MS


def status_of(generation_id):
    return Generation.objects.filter(pk=generation_id).values_list('status', flat=True).first()


async def hold(call, generation_id, *, max_wait_seconds=None, clock=time.monotonic, sleep=asyncio.sleep, read=status_of,
               terminal=TERMINAL, busy=BUSY_NOTE):
    """Wait until the job (a generation unless ``read``/``terminal`` say otherwise) is terminal or the budget is spent;
    returns ``busy`` when the wait was skipped for want of a slot."""
    deadline = call.started + wait_seconds(max_wait_seconds)
    if clock() >= deadline or await db(read, generation_id) in terminal:
        return None
    async with hold_slot(call.principal) as slot:
        if slot is None:
            return busy
        began = clock()
        while True:
            remaining = deadline - clock()
            if remaining <= 0:
                return None
            await sleep(min(FAST_POLL_SECONDS if clock() - began < FAST_PHASE_SECONDS else SLOW_POLL_SECONDS, remaining))
            if await db(read, generation_id) in terminal:
                return None
