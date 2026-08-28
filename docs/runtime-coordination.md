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
