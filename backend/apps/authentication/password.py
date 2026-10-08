"""Current Node scrypt format, including textual hex salt and UTF-16 length."""
import hashlib
import hmac
import secrets


def validate_password(password):
    if not isinstance(password, str):
        return 'Password is required.'
    length = len(password.encode('utf-16-le', errors='surrogatepass')) // 2
    if length < 8:
        return 'Password must be at least 8 characters.'
    if length > 128:
        return 'Password must be no more than 128 characters.'
    return None


def derive(password, salt):
    # Node replaces lone UTF-16 surrogates during UTF-8 conversion.
    normalized = password.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace')
    return hashlib.scrypt(normalized.encode('utf-8'), salt=salt.encode('utf-8'),
                          n=16384, r=8, p=1, dklen=64, maxmem=32*1024*1024)


def hash_password(password):
    salt = secrets.token_hex(16)
    return {'hash': derive(password, salt).hex(), 'salt': salt}


def verify_password(password, stored_hash, salt):
    try:
        candidate = derive(password, salt)
        known = bytes.fromhex(stored_hash)
        return len(candidate) == len(known) and hmac.compare_digest(candidate, known)
    except (ValueError, TypeError, AttributeError, UnicodeError):
        return False
