"""Port of src/lib/depth-worker-auth.js — see that file's docstring for the
full reasoning (one shared bearer token for every worker; workers self-
identify via workerId in the request body, not the token; unset token
refuses every request rather than allowing them through)."""

import hmac
import os


def verify_worker_token(request) -> bool:
    configured = os.environ.get("DEPTH_WORKER_TOKEN")
    if not configured:
        return False

    header = request.headers.get("Authorization", "") or request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return False
    given = header[7:]
    return hmac.compare_digest(given, configured)
