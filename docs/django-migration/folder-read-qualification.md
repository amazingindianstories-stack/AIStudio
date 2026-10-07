# Folder read qualification

Real current Next and Django HTTP comparison passes nine queries: global root,
tree=1, tree=true precedence over ancestry, parent scope ignoring project filter,
project roots, full ancestry, missing ancestry, repeated tree parameters and
repeated parent parameters. Equal status/JSON and unchanged snapshots of users,
settings, user_limits, projects and folders are required for each request.
Query values now preserve Next's first-value behavior for repeated parameters.

Disposable PostgreSQL 18 and minimal unmanaged fixture tables are used. This
proves the tested responses only. Nonempty project roots, sorting/collation,
malformed IDs and DB failure error bodies, cycles, renewal forwarding, browser,
performance and production schema invariants remain open. No folder mutation
implementation or traffic transfer is claimed. CI runs this harness alongside
settings parity against disposable PostgreSQL 16; remote CI is unverified.
