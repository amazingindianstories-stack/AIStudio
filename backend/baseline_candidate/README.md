# Candidate schema baseline

This graph contains 21 CreateModel migrations and one RunSQL migration for the
current hierarchy/naming invariants and additive foreign-key aliases. It is
serialized from the qualified current migration state, with explicit database
defaults, indexes, constraints, FK policies and column order. Cross-domain
relationships determine dependencies; each model is created after its targets.

Production settings do not select these modules. The active unmanaged graph and
Drizzle schema authority remain unchanged. The isolated reproduction probe selects
this graph with `override_settings(MIGRATION_MODULES=...)` and executes it through
Django's MigrationExecutor. No fixture schema editor creates application tables
in that mode. Django's migration recorder is included in both compared catalogs,
so no bookkeeping catalog differences are silently filtered out.

Qualification command, through the isolated runner:

```
python scripts/django-migration/schema-reproduction-probe.py --migration-executor --require-equivalent
```

The graph is a candidate for the reviewed schema takeover, not instructions to
run against an existing database. Existing tables must never be recreated.
PostgreSQL 16 fresh committed database qualification passed through the isolated
container harness (`--runtime --declared-schema --invariants --baseline`).
Before promotion: audit actual production catalogs, reconcile prior Django migration history, verify
backup/PITR, review fake-baselining and rollback, then deliberately select the
approved graph and managed model state. The invariant migration is intentionally
irreversible: table/function removal requires a separate reviewed operation.

The current local source includes the separate Asset Library folder-color change;
its migration must be integrated before clean-checkout CI qualification succeeds.

The PG16 harness creates a second empty database inside its tmpfs-only PostgreSQL
container, applies the candidate graph with real commits, reconnects, verifies all
22 history entries and an empty plan, compares full catalogs, runs invariant SQL
with its real transaction boundaries, and exercises generation ORM/history reads.
Both databases and the internal network are removed by the harness after the run.
Evidence: `docs/django-migration/schema-pg16-baseline-evidence.json`.
