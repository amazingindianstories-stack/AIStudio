"""The real client address, for per-address rate limits.

Railway's edge appends the address of the peer that connected to it, which on Green is a Vercel egress
address shared by every artist, so no X-Forwarded-For or X-Real-IP entry that reaches Django names the
client. The only address we can trust is the one Vercel itself reports to ``src/middleware.js``
(``x-vercel-forwarded-for``, which a caller cannot overwrite). The chain:

1. The middleware writes it to ``x-veevee-client-ip``, replacing any caller value.
2. ``deploy/gateway.py`` authenticates the ingress secret, strips every caller-supplied
   ``x-veevee-client-ip*`` header, and adds ``X-Veevee-Client-Ip-Proof``:
   ``v1.<unix seconds>.<HMAC-SHA256(key, "v1|<seconds>|<address>")>``.
3. This module accepts the address only with a valid, fresh proof under ``VEEVEE_CLIENT_ADDRESS_KEY``
   (derived by the entrypoint from the ingress secret, so Django never holds the secret itself).

Anything else (no header, a forged or stale proof, no key, a private or otherwise non-global address)
is *untrusted*: ``address_key`` returns None and every per-address limit stands down, so a shared
bucket can never lock every artist out. The per-account limits do not depend on the address.
"""
import hashlib
import hmac
import ipaddress
import time

from django.conf import settings

ADDRESS_HEADER = 'X-Veevee-Client-Ip'
PROOF_HEADER = 'X-Veevee-Client-Ip-Proof'
PROOF_VERSION = 'v1'
# Gateway and Django run in one container, so the real skew is milliseconds; this only bounds replay.
PROOF_MAX_SKEW_SECONDS = 120


def sign(key, address, now=None):
    """The proof the gateway attaches (``deploy/gateway.py`` carries a copy; a test keeps them equal)."""
    seconds = int(time.time() if now is None else now)
    mac = hmac.new(key.encode(), f'{PROOF_VERSION}|{seconds}|{address}'.encode(), hashlib.sha256).hexdigest()
    return f'{PROOF_VERSION}.{seconds}.{mac}'


def canonical(value):
    """The bucket form of an address, or None when it is not a routable client address.

    IPv4-mapped IPv6 becomes IPv4; other IPv6 collapses to its /64, the unit one subscriber controls, so
    rotating the low 64 bits does not mint fresh buckets. Private, loopback, link-local, CGNAT and
    documentation ranges are not clients (they are our own hops), so they are untrusted.
    """
    try:
        address = ipaddress.ip_address(str(value).strip())
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if not address.is_global:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        return str(ipaddress.ip_network(f'{address}/64', strict=False).network_address) + '/64'
    return str(address)


def trusted_address(request, now=None):
    """The canonical client address when the gateway vouches for it, else None."""
    key = getattr(settings, 'VEEVEE_CLIENT_ADDRESS_KEY', '')
    value = request.headers.get(ADDRESS_HEADER)
    proof = request.headers.get(PROOF_HEADER)
    if not key or not value or not proof:
        return None
    try:
        version, seconds, mac = proof.split('.')
        issued = int(seconds)
    except ValueError:
        return None
    current = time.time() if now is None else now
    if version != PROOF_VERSION or abs(current - issued) > PROOF_MAX_SKEW_SECONDS:
        return None
    if not hmac.compare_digest(sign(key, value, issued), proof):
        return None
    return canonical(value)


def address_key(request):
    """The address bucket key, or None while per-address limits are off or the address is untrusted."""
    if not getattr(settings, 'VEEVEE_ADDRESS_RATE_LIMITS', False):
        return None
    address = trusted_address(request)
    if address is None:
        return None
    return hashlib.sha256(address.encode()).hexdigest()[:32]
