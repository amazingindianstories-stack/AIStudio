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
   block silently. (Verified present 2026-07-10.)

8. **design.md file-plan item 6 retargeted (2026-07-10).** Commit `849ef9d`
   (user, 2026-07-08 20:51, after design.md was authored) moved the image
   route's execution logic — assemblePrompt, best-of-N, judgeIdentity, the
   Higgsfield branch, `maxDuration = 60` — verbatim into
   `src/app/api/queue/execute/route.ts`; `generate/image/route.ts` now only
   enqueues. The implementer correctly stopped on the conflict; orchestrator
   verified the move (same logic, same 60s ceiling, so the design's latency
   math still holds) and authorized implementing item 6 in
   `queue/execute/route.ts` instead. No other design change.

9. **Review adjudication (2026-07-10).** Code review verdict: safe to commit;
   flag-off byte-identical invariant CONFIRMED across all files; four minor
   findings, all confined to off-by-default flags.
   - FIXED: `crispen`'s `median(1)` was a confirmed no-op — removed it and
     documented the pass as sharpen-only, matching the behavior the A/B
     visually validated (switching to `median(3)` would have changed
     validated behavior; rejected).
   - FIXED: `PROMPT_ROLE_DETECT` ran detection even when a prompt-text role
     existed, adding ~3s/ref of sequential hot-path latency (and pointlessly
     on the Higgsfield branch) — the cross-check WARN is now fire-and-forget
     (resolves during generation); detection is awaited only when the role is
     genuinely unknown, per the design's data flow.
   - ACCEPTED: `parseRefRoles` keyword priority (outfit/location/style before
     person) can mislabel a person ref in prompts like "@img1 standing in the
     room". Reordering just moves the failure to outfit/location prompts that
     mention people ("the character wearing @img2"); the detection cross-check
     exists for exactly this. Documented limitation of an off-by-default flag.
   - ACCEPTED: SUPERSAMPLE's halve-for-delivery is exact for 2K→4K (the
     validated pair) and may drift a few pixels for 1K→2K. Cosmetic, flag off
     by default.
   Post-fix: 34/34 tests pass, `npm run build` clean.

10. **Controls executed 2026-07-10** (within the 2-run approval): jobs
   `1ea32472…`/`84ade7fc…`, ~14¢ each ≈ 28¢ total on the user's Higgsfield
   account. Refs delivered via `media_import_url` pointing at our public
   media proxy (media_upload's presigned flow 401'd on a stale token; see
   recon fact 9). Outcome in recon facts 7–8: both controls beat our
   baselines on composition/sharpness with IDENTICAL starved refs + prompt →
   payload-shape (scaffolding) became the prime suspect; an "HF-mimic
   minimal payload" variant was added to the Stage 2 A/B matrix beyond
   design.md's original four.
