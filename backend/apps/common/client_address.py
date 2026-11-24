"""Client address for rate limits. Only meaningful behind Vercel, which appends the real
client address to X-Forwarded-For; earlier entries and X-Real-IP are client-controlled."""
import hashlib
import ipaddress


def _is_loopback(value):
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def client_ip(request):
    entries = [part.strip() for part in (request.headers.get('X-Forwarded-For') or '').split(',') if part.strip()]
    for entry in reversed(entries):
        if not _is_loopback(entry):
            return entry
    return request.META.get('REMOTE_ADDR', '')


def address_key(request):
    return hashlib.sha256(client_ip(request).encode()).hexdigest()[:32]
