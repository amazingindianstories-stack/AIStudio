# Process-scoped runtime coordination

Some mutable values deliberately sit outside Zustand and the database because
they coordinate work performed by one JavaScript process; they are not
rendered application state and should not trigger UI updates.

- `src/lib/store-runtime.js` owns client polling IDs, timeout handles, live-feed
  scheduling fields, debounce handles, and monotonic request sequence counters.
  `disposeStoreRuntime()` clears all of them on logout, authentication teardown,
  and between isolated tests. It leaves Zustand's rendered values alone, so a
  later session can start cleanly without recreating the module.
- `src/lib/store-db.js` owns the stale-generation reaper's last-run timestamp.
  The timestamp only suppresses duplicate idempotent SQL sweeps within one warm
  server instance. `resetStoreDbRuntimeState()` provides a deterministic test or
  process-teardown boundary; resetting it cannot change queue correctness.
- Component-owned intervals, such as the depth-worker status interval in
  `TopBar.jsx`, remain inside React effects because their cleanup is tied to the
  component lifecycle rather than the lifetime of the store module.

None of these values are durable, shared between instances, or authoritative.
Durable generation state remains in PostgreSQL; cross-instance coordination
uses database locks/leases.
# Browser navigation safety

The asset viewer's arrow-key list must keep every candidate predicate inside
the `items.filter((candidate) => ...)` callback. Do not append a project-scope
condition after the closing `)` of `filter`: the callback variable is not in
scope there, and production minification turns that mistake into an opaque
`ReferenceError: candidate is not defined` during `useMemo`.

When changing navigation, verify the compiled production build and test the
viewer with a project selected. The navigation list must be derived from the
current server-filtered `items` feed, keep the project guard inside the filter
callback, and never reference `candidate` outside that callback.

## Mention namespace safety

Every attached-media namespace must be represented in all three places: the
shared parser, the `MentionTextarea` autocomplete/highlight layer, and the
composer prop that supplies the attached items. In particular, `@audioN` is a
real Seedance reference tag, not a named asset slug. If only the provider
recognizes it, the UI renders it as an invalid red tag and typed tags cannot be
selected reliably.

## Worker route boundary

The persistent Railway generation worker has no browser session. Any API route
it calls must be exempted from the cookie-presence middleware and must perform
its own header/token verification in the route handler. In particular,
`/api/queue/execute` must remain middleware-exempt while requiring the exact
`x-generation-worker-secret`; otherwise the middleware returns 401 before the
worker authentication code runs and every generation remains queued.
