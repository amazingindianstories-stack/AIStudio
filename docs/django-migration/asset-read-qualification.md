# Asset read qualification — 2026-10-08

Actual current Next and Django HTTP handlers pass five comparisons on a newly
created disposable local PostgreSQL cluster: anonymous denial, authenticated
all-assets read, project-only filter, empty first repeated projectId, and an
unknown project. Status/JSON match and six-table snapshots remain unchanged.
Fixtures include global/project assets, nullable metadata, stored media path,
and distinct creation times. No object-storage/provider request is made.

The same run revalidated seven settings and nine folder comparisons plus the
same-origin settings rewrite. The previous temp environment was missing, so it
was not reused; the fresh cluster was verified by the isolation runner.

This does not prove production schema equivalence, malformed-ID/database error
parity, comprehensive headers, browser behavior, performance or hosted traffic.
GET assets remains IMPLEMENTING and Next-owned. Mutations are not implemented.
