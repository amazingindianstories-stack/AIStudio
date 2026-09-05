"""Port of src/lib/password.js. scrypt params must stay byte-identical to
Node's crypto.scryptSync defaults (N=16384, r=8, p=1, maxmem=32MiB) — a
user created via one app's admin route must have a password verifiable
by the other's login route. Verified interop 2026-08-10: a hash minted by
Node's scryptSync was reproduced byte-for-byte by hashlib.scrypt with
these exact parameters.
"""

import hashlib
import hmac
import os

MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

_SCRYPT_N = 16384
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_MAXMEM = 32 * 1024 * 1024
_KEY_LEN = 64


def validate_password(password) -> str | None:
    if not isinstance(password, str):
        return "Password is required."
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters."
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be no more than {MAX_PASSWORD_LENGTH} characters."
    return None


def hash_password(password: str) -> dict:
    salt = os.urandom(16).hex()
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt.encode("ascii"),
        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, maxmem=_SCRYPT_MAXMEM, dklen=_KEY_LEN,
    )
    return {"hash": digest.hex(), "salt": salt}


def verify_password(password: str, hash_hex: str, salt: str) -> bool:
    try:
        candidate = hashlib.scrypt(
            password.encode("utf-8"), salt=salt.encode("ascii"),
            n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, maxmem=_SCRYPT_MAXMEM, dklen=_KEY_LEN,
        )
        known = bytes.fromhex(hash_hex)
        return len(candidate) == len(known) and hmac.compare_digest(candidate, known)
    except Exception:
        return False
