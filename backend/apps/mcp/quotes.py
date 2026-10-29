"""Quote tokens for paid tools (architecture v2 section 4.4).

A quote is an HMAC (``MCP_QUOTE_SECRET``) over the user, the token grant, the tool, the canonical arguments, the price
and a 10-minute expiry, so a quote for a 4 s 480p clip can never pay for a 15 s 1080p one. The token carries those
values in the clear (nothing secret: ids, a digest and cents) and the signature binds them. A quote pays for exactly
one job: ``consume`` records the quote and that job's id in the transaction that creates the row, until the quote
expires, and a later call with the same quote gets that job back.
"""
import base64
import binascii
import hashlib
import hmac
import json
import secrets

from django.conf import settings

from apps.common.leases import now_ms
from apps.library.models import OrganizationIdempotencyKey
from .shapes import dollars, iso

TTL_MS = 10 * 60 * 1000
PREFIX = 'vq1'
# Arguments that steer one call (waiting, approval, retries) and never change what is made or what it costs.
CONTROL_FIELDS = ('wait', 'maxWaitSeconds', 'includePreview', 'quoteToken', 'confirmedByUser', 'idempotencyKey')


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(arguments):
    return hashlib.sha256(canonical_json(arguments).encode()).hexdigest()


def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def _unb64(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _sign(body):
    return _b64(hmac.new(settings.MCP_QUOTE_SECRET.encode(), body.encode(), hashlib.sha256).digest())


def mint(principal, tool, arguments, cost_cents, summary, *, now=None):
    """A ``Quote`` for this exact call; ``requiresUserConfirmation`` at or above the confirmation amount."""
    now = now_ms() if now is None else now
    expires = now + TTL_MS
    payload = {'v': 1, 'q': secrets.token_hex(8), 'u': str(principal.user.id), 't': str(principal.token_id), 'tool': tool,
               'a': digest(arguments), 'c': cost_cents, 'e': expires}
    body = _b64(canonical_json(payload).encode())
    return {'token': f'{PREFIX}.{body}.{_sign(body)}', 'costCents': cost_cents, 'display': dollars(cost_cents),
            'expiresAt': iso(expires), 'summary': summary,
            'requiresUserConfirmation': cost_cents >= principal.caps.confirm_at_cents}


def verify(principal, tool, arguments, token, *, now=None):
    """The quote's payload when ``token`` is genuine, unexpired and was minted for this caller and these arguments."""
    now = now_ms() if now is None else now
    parts = token.split('.') if isinstance(token, str) else []
    if len(parts) != 3 or parts[0] != PREFIX or not hmac.compare_digest(_sign(parts[1]), parts[2]):
        return None
    try:
        payload = json.loads(_unb64(parts[1]))
    except (binascii.Error, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get('v') != 1 or type(payload.get('c')) is not int or type(payload.get('e')) is not int:
        return None
    if (payload['e'] <= now or payload.get('u') != str(principal.user.id) or payload.get('t') != str(principal.token_id)
            or payload.get('tool') != tool or payload.get('a') != digest(arguments)):
        return None
    return payload


def echo(principal, token, payload, summary):
    """The ``Quote`` a submission paid with, rebuilt from its verified token."""
    return {'token': token, 'costCents': payload['c'], 'display': dollars(payload['c']), 'expiresAt': iso(payload['e']),
            'summary': summary, 'requiresUserConfirmation': payload['c'] >= principal.caps.confirm_at_cents}


def consume(payload, generation_id):
    """Spend the quote on ``generation_id``: None when it was unspent, else the id of the job it already paid for.
    Call inside the transaction that creates the row, so a refused or failed submission leaves the quote unspent."""
    spend, created = OrganizationIdempotencyKey.objects.get_or_create(pk='mcp-quote:' + payload['q'], defaults={
        'actor_id': payload['u'], 'operation': 'MCP_QUOTE', 'fingerprint': payload['a'], 'result': {'id': generation_id},
        'created_at': now_ms(), 'expires_at': payload['e']})
    return None if created else spend.result['id']
