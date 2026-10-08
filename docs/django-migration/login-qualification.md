# Login qualification — 2026-10-08

Actual current Next and Django handlers independently run against reset,
disposable PostgreSQL fixtures with synthetic credentials. Each passes:
missing credentials 400; normalized valid email/password 200; compatible
HttpOnly/Lax 30-day cookie accepted by both runtimes; five nonexistent-account
failures 401; sixth attempt 429 with retry header within the measured rolling
window; exactly five normalized failed-attempt rows; one login activity event
with matching actor/action/null detail. Nondeterministic IDs/timestamps are
validated by their invariants, not asserted byte-identical across reset runs.

The full HTTP harness also passes settings/folder/asset/current-user/project
comparisons, mixed-runtime default-project concurrency and same-origin rewrite.
No real user, provider, storage or shared database is used.

Still required: disabled/incorrect-password combinations and expiry HTTP cases,
malformed JSON/type coercion parity, Origin/CSRF/security qualification, secure
hosted cookie forwarding, browser, PostgreSQL 16 CI and preview canary. Login
routing is not selected; Next remains authoritative issuer. This evidence is
not production authorization or final authentication acceptance.

Logout extension: both runtimes pass anonymous and authenticated POST logout
with equal response/cookie contract and one authenticated logout audit event.
Focused Django coverage additionally checks clearing overrides aged renewal.
