# Stage 3 review findings — Gemini Omni Flash video integration

Reviewers: code-reviewer (correctness/quality) and security-reviewer, both run
in parallel against the rebuilt diff, fresh context, read-only.

## Code review (8 findings, all minor)

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | `steps[].content` webm videos get stored with `Content-Type: image/webm` (`storage.ts`'s `extToMime` had no webm case) — playback would break if Omni ever returns webm (only mp4 observed so far) | CONFIRMED | **FIXED** — added `if (e === "webm") return "video/webm";` |
| 2 | Stale comments in `config.ts` (`durationsForModel`) and `generate/video/route.ts` still said "duration is prompt-driven / not a request param," contradicting the corrected contract (D11) that the actual code correctly implements | CONFIRMED | **FIXED** — comments updated to match the real, enforced `response_format.duration` field |
| 3 | No transient-error retry on Omni status polling (`getOmniVideoStatus`'s fetch), unlike `gemini.ts`'s one-retry-on-429/5xx convention; a single transient poll error surfaces as a spurious failed state to the client (DB stays `running`, recoverable on reload) | PLAUSIBLE | **DEFERRED** — real but low-severity robustness gap, shared conceptually with how other providers' poll paths are not retried either; out of scope for this ship, logged as a follow-up |
| 4 | A single `saveBase64` failure on a successfully-generated (billed, non-refetchable) Omni video permanently loses it, with no retry | CONFIRMED | **FIXED** — added one retry (1s backoff) before marking the item terminally failed |
| 5 | `buildOmniInput` doesn't mirror `gemini.ts`'s `buildCastPolicy` (zero-cast/camera-direction contract for location-only scenes) | CONFIRMED (feature exists) | **DEFERRED, deliberately** — `buildCastPolicy` was added to `gemini.ts`/`shot-spec.ts` by a concurrently-running, uncommitted process during this session (see decisions.md D12); depending on in-flight, not-yet-stable code from an unrelated concurrent session is a new risk this review introduces, not one worth taking to close a minor parity gap. Revisit once that work lands and stabilizes. |
| 6 | `createOmniVideoTask`'s `json?.id \|\| json?.name` id extraction is untested on the Vertex wire path; if Vertex returns a full resource path in `name`, the poll URL could double up `interactions/` segments | PLAUSIBLE | **DEFERRED** — Vertex path is flag-gated, allowlist-gated, and untestable on this machine (dead creds); will be re-verified when Vertex access is restored (see user follow-ups) |
| 7 | Theoretical fallthrough: if `getOmniVideoStatus` ever returned `succeeded` without `videoBase64`, the status route would persist a broken "succeeded, no url" item instead of failing loudly (currently unreachable — `extractOmniVideo` always throws in that case) | CONFIRMED (defensive gap) | **FIXED** — added an explicit guard that treats `succeeded` without video as a failed item |
| 8 | Untracked `vercel-gcp-cred.json`/`test.json` at repo root, unrelated to this feature | CONFIRMED, out of scope | **NOT ACTED ON** — flagged to the user in the final report, not part of this diff |

## Security review (0 new findings)

- S1 (host allowlist on the credential-attaching download path) and S2 (API
  key/bearer token only ever in headers, never a URL) — both re-verified
  correctly implemented and test-covered.
- S3 (job-ownership gap — status/execute routes don't check `item.userId`
  against the session) — re-confirmed pre-existing via `git show HEAD` on the
  pre-Omni status route; not worsened by this change. Still deferred per D10.
- `OMNI_USE_VERTEX=1` fails closed (throws before any network call) on a
  missing project id/token — no credential-misdirection risk found.
- `scripts/probe-omni.ts` confirmed safe by construction: all zero-cost
  probes send `input: []`; only `--live` sends real content.
- Informational, out of scope: `vercel-gcp-cred.json` (untracked, not
  `.gitignore`d) contains GCP Workload Identity Federation config details
  (token_url, credential_source, service_account_impersonation_url) — no
  static private key, but worth a `.gitignore` entry. Not part of this
  feature's diff; flagged to the user, not acted on.

## Post-fix verification

`npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts src/lib/omni-input.test.ts src/lib/providers/omni.test.ts` — 78/78 passing.
`npm run build` — green.
