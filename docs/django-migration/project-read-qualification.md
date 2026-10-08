# Project GET qualification — 2026-10-08

Real Next/Django populated project HTTP responses match, including associated
folder projection and omitted null brief. Anonymous reads return matching 401.
Database snapshots remain unchanged for populated reads.

Each runtime independently receives an empty project table and creates one
My Project row, UUID ID, null brief/creator and equal created/updated timestamps.
Repeated reads return the same object and do not change the DB. IDs/times are
validated as nondeterministic fields rather than forced equal across resets.

Twelve simultaneous mixed Next/Django HTTP requests (six threads) against an
empty shared disposable project table return the same project ID; exactly one
row exists. This proves the tested cross-runtime advisory-lock boundary. The
Django-specific suite separately tests twelve concurrent creation calls.

All HTTP suites and same-origin settings rewrite pass on disposable PostgreSQL
18. Full-schema PostgreSQL 16, browser, hosted preview, authorization/error edge
cases and performance remain pending. No traffic owner or schema owner changed.
