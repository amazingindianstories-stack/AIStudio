# Repository operating rules

## Database changes and deployments

Production deploys do **not** apply Drizzle schema changes. Vercel builds and
deploys application code only. `npm run test:db:setup` is also not migration
coverage: it creates the final schema from scratch, so it cannot prove that an
existing production database can be upgraded to that schema.

When a change adds, removes, renames, or changes a column/index/table:

1. Add an additive, idempotent migration in `scripts/` and expose it as a
   `db:migrate:*` package script. Never rely on editing `src/lib/schema.js`
   alone.
2. Update `src/app/api/admin/migrate-schema/route.js` when the online admin
   migration path owns the affected table. Its verification query and expected
   count must change with its statements.
3. Add the migration to the database CI job and test upgrading an old schema,
   not only creating the latest schema with `drizzle-kit push`.
4. Run the additive migration **before** deploying code that reads or writes
   the new shape. Then run `npm run db:verify:production-schema`. A failed
   verifier is a deployment blocker.
5. Keep migrations backward-compatible for the currently deployed application
   so the required order is always expand schema, deploy code, then optionally
   clean up in a later release.

Do not put `drizzle-kit push` in a Vercel build command. Preview builds may use
production-connected environment variables, builds can run more than once,
and an application build is not a controlled migration phase.

Generation inserts are especially sensitive: `itemToValues()` in
`src/lib/store-db.js` writes a wide row, so one missing `generations` column can
break only the generation kinds that exercise that path. Before releasing a
generation feature, test one non-billed enqueue for every affected kind after
the production-schema verifier passes.

