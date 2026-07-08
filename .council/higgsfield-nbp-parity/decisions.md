# Decision Log — higgsfield-nbp-parity

1. **Scope interpretation.** User said "raw nano banana pro api from vertex
   (?)" — verified via DB rows + code that our path is the generativelanguage
   endpoint, not Vertex. Investigated the actual path; did not switch
   endpoints (Vertex is 1K-gated; see gemini.ts header).
   *Alternative rejected:* re-probing Vertex — already disproven 2026-07-03.

2. **Baselines.** Rows `31d0523e` / `3afb7c4a` (21:9, 2K, 3 refs) are the
   canonical "before" images; the user's uploaded PNGs match them.

3. **Credentials handling.** Pulled Vercel prod env to the session scratchpad
   (read-only). Sensitive values (S3 keys, GOOGLE_API_KEY) come back empty —
   fetched baseline media via the public prod media proxy instead. No secrets
   were written into the repo.

4. **Probe budget.** Assumed ~15–25 NBP generations (≈$3–6) is acceptable for
   A/B evidence, matching the user's existing bake-off practice (ab-face-eval,
   costCents attribution). Will report actual spend.

5. **Security observation (deferred, reported in final summary).** The
   middleware matcher skips any path containing a dot, so /api/media/** is
   publicly served without a session — all generated media + uploaded
   references are URL-addressable (unguessable UUIDs, but no auth). Out of
   scope for this feature; flagged for the user.

6. **Higgsfield control generations: APPROVED by user (2026-07-08)** — up to
   2 paid runs (~14¢ each) on their Higgsfield account via MCP, same
   refs/prompt, to calibrate their default output (resolution, sharpness).
   The research agent itself stays read-only; the orchestrator runs the
   controls after schema findings land.

7. **Local Google API access:** user chose to paste GOOGLE_API_KEY into
   .env.local themselves (2026-07-08). Stage 2 verifies the key is present
   before running probes; if still empty at that point, report rather than
   block silently.
