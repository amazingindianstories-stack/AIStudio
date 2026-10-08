# Password PATCH qualification — 2026-10-08

Each actual Next/Django runtime independently receives reset synthetic account
credentials in disposable PostgreSQL. Incorrect current passwords return the
same 401/error without hash/version changes. Successful change returns ok:true,
increments auth_version to one, stores a scrypt hash verifying the new password,
and writes one password_changed event with matching actor and null detail.
The reissued 30-day HttpOnly/Lax cookie is accepted by both runtimes; both reject
the old cookie. Generated hashes, salts and timestamps are validated by their
invariants rather than forced byte-identical across resets.

Django-specific tests additionally verify a concurrent version change returns
409, clears the cookie, preserves the password hash and creates no audit event.
Full HTTP harness passes after extension.

Still required: comprehensive validation/malformed-input cases, real mixed-runtime
concurrent password updates, Origin/CSRF qualification, browser/hosted secure-cookie
behavior and preview/canary evidence. No auth routing or issuer transfer occurred.
