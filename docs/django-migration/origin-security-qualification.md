# Browser Origin qualification — 2026-10-08

Actual Django HTTP requests reject untrusted Origin, null Origin and cross-site
Fetch Metadata without Origin for login POST, logout POST and password PATCH:
nine rejection cases, all 403 FORBIDDEN_ORIGIN. A configured exact frontend Origin
reaches login input validation (400 for missing credentials). Application table
snapshots and separate login-attempt/activity counts remain unchanged after all
denials. The full Next/Django contract harness passes alongside these checks.

This is deliberate strengthened Django behavior, not claimed Node parity.
Focused API tests separately cover the same policy. Production settings require
explicit HTTPS frontend origins, but no deployment setting has changed.

Hosted Vercel rewrite Origin forwarding, real browser Fetch Metadata/cookies,
legacy browser coverage and broader future mutation/worker exceptions remain
unqualified. These local HTTP tests do not close the browser/hosted cutover gate.
