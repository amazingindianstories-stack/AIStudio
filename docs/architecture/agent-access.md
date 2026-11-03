# Agent access (MCP auth and identity)

AI agents (Claude, ChatGPT, Cursor, Claude Code and other MCP clients) act as one Veevee user through
an opaque bearer token. `backend/apps/mcp_auth` owns the tokens, the OAuth 2.1 authorization server, the
per-user opt-in and the spending controls. The MCP server itself (`/mcp`, its tools and its Vercel route,
`mcp-server.md`) is a separate service built on this app; it calls the Python interface below, never these HTTP
endpoints.

## Who may connect

- Agent access is an admin opt-in per user and off by default: the `mcpEnabled` user limit, set from the
  admin Users tab (Limits dialog, "Agent access (MCP)"). The same dialog revokes every token a user holds and
  their Agents tab grant.
- `mcpDailyCapCents` (default 2000, $20) and `mcpActiveJobs` (default 4) are ordinary registered limits
  (`admin_dashboard/views.py` `LIMITS`, `src/lib/limits.js`): a global default with per-user overrides.
- `mcpDailyCapCents` is labelled "Agent daily cap" and covers MCP and the Agents tab. `controls.spent_cents` adds
  the user's `agent_llm_usage` cost for the trailing 24 hours (microcents summed, rounded up once to whole cents); a
  per-token total adds LLM rows only for an Agents tab grant, matched by `grant_id`. `admit_paid_submission` keeps
  its per-user lock and checks; `agentGlobalDailyCapCents` (all users' agent generations plus all LLM cost) is
  enforced only by the worker's `check_step`, so MCP admission has no account-wide serialization point.
  Settings, Agent access shows the same `spent_cents` total as the user's spent today.
- Agents tab limits (`apps/agents/limits.py`, all in `LIMITS` and `src/lib/limits.js`): `agentActiveRuns` (2),
  `agentMaxStepsPerRun` (40), `agentMaxRunCostCents` (1000), global-only `agentGlobalDailyCapCents` (20000) and
  `agentMaxConcurrentRuns` (8), and attachment limits `agentAttachMaxMb`, `agentAttachMaxVideoSeconds`,
  `agentAttachMaxAudioSeconds` plus 1/0 switches `agentAttachImages`, `agentAttachDocuments`, `agentAttachVideo`,
  `agentAttachAudio`. A per-user row overrides the global value. They are not composer settings.
- Run creation (`check_run_admission`) checks only `agentsEnabled` and `agentActiveRuns`; a run is created queued
  even when `agentMaxConcurrentRuns` runs are running, and `check_global_concurrency` is the worker claim's check.
- `agentsEnabled` (1/0): a global 0 is a kill switch, off for everyone including admins and per-user overrides.
  Otherwise a per-user row decides, then a global 1 (on for all), and with nothing set it is on for admins only.
  The dashboard omits the key while no global row exists, and `POST /api/admin/limits` with `value: null` deletes
  the global row to return to admins only (the Limits tab's "Reset to default").
- Mid-run, `check_step` returns a `LimitHit` (`disabled`, `steps`, `run_cost`, `daily_cap`, `grant_daily_cap` for
  the Agents tab grant's own `daily_cap_cents`, `global_daily_cap`).
  `apply_limit_hit` pauses the run (`paused_limit`, `pause_reason` = kind, `resume_after` from the oldest rows
  that free enough of the trailing window, none for step, run-cost and disabled) and records the kind in
  `agent_runs.error.hits`; a second refusal of the same kind ends the run `failed` with
  `error = {code: 'limit', kind}`. The pause records the refused step's estimate in `error.costCents`, and
  `resume_run` requeues only when that same step fits again.
- Each grant (a personal access token or one connected app) has its own daily cap (default $10, never above
  the user cap) and an auto-approve amount (default 25 cents, 0 to 100). Jobs at or below the auto-approve
  amount start right away unless they cost $1.00 or more: those always need the user's confirmation, whatever
  the auto-approve amount. Amounts are estimator cents, the unit of `generations.cost_cents`.

## Tokens

`mcp_tokens` stores SHA-256 hashes only; the secret is shown once. Prefixes make leaks scannable:
`vv_pat_` (personal access token, 90 days by default, up to 365), `vva_` (OAuth access, 1 hour) and `vvr_`
(OAuth refresh, 30 days, rotated on every use). `family_id` is the grant: a personal access token is its own
family, and an OAuth connection's access and refresh tokens share one across rotation, so caps, spend and
revocation follow the family. Every token is bound to the resource `PUBLIC_APP_URL + /mcp` and to the user's
`auth_version`, so a password, role or status change ends it exactly like a cookie session; password changes
and admin account changes also mark every token revoked.

The in-app Agents tab acts through an agent grant instead (`agent_grants`, `apps/agents/grants.py`): one live
grant per user, with no secret, so it never authenticates over HTTP. It is an in-process principal of kind
`agent` with the read, generate and organize scopes, never admin. Its jobs are `created_via='agent'` with
`mcp_token_id` set to the grant id, and they share the user's agent daily cap and active jobs with MCP grants
(`policy.AGENT_ORIGINS`). `mcpEnabled` gates MCP tokens only; the Agents tab's caller checks its own switch.
Every "revoke all agent access" path (`tokens.revoke_all_for_user`) also revokes the grant, and so does the
user's `auth_version` changing.

Users manage tokens and connected apps in Account settings, Agent access (`/api/mcp/tokens`,
`/api/mcp/connections/<id>`).

## OAuth 2.1 authorization server

| Endpoint | Path |
|---|---|
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource/mcp` (served by Django at `/api/oauth/protected-resource`) |
| Authorization server metadata (RFC 8414) | `/.well-known/oauth-authorization-server` (served at `/api/oauth/authorization-server`) |
| Dynamic client registration (RFC 7591) | `POST /api/oauth/register`, 20 per client address per hour |
| Authorization | `/oauth/authorize`, the Next.js consent page, backed by `/api/oauth/authorize/request` and `/decision` |
| Token | `POST /api/oauth/token`: `authorization_code` with PKCE S256, `refresh_token` with rotation; 60 per client and client address per minute |
| Revocation (RFC 7009) | `POST /api/oauth/revoke` |

- Public clients only (`token_endpoint_auth_method: none`). A client is either registered (DCR, `vvc_` id)
  or identified by an https Client ID Metadata Document URL (CIMD), fetched with pinned public DNS, no
  redirects, 5 KB and 5 s in total, and cached for an hour; any fetch or parse failure is `invalid_client`.
- Redirect URIs are https or loopback http (`127.0.0.1`, `[::1]` or `localhost`, any port), with no userinfo,
  fragment or backslash; a supplied redirect passes the same check before it is matched. That covers
  every in-scope client's documented redirect: Cursor's `https://www.cursor.com/agents/mcp/oauth/callback`
  and `http://localhost:8787/callback` (https://cursor.com/docs/context/mcp), VS Code's
  `http://127.0.0.1:33418` and `https://vscode.dev/redirect`, and Claude's and ChatGPT's https or loopback
  callbacks. Private-use native schemes (`cursor://`, `vscode://`, `com.example.app:/`) are refused: none is
  documented by a primary source for MCP OAuth, and adding one needs that verification. A client without a
  verified redirect connects with a personal access token. The consent page shows where the decision returns
  before the user chooses.
- A code works once, for two minutes, for its client, redirect URI and PKCE verifier; a replay revokes the
  grant it produced. Presenting an already rotated refresh token revokes the whole grant. Responses carry
  `iss` (RFC 9207).
- The register, token and revoke endpoints read no cookies, so `apps.common.origin` lets browser-based
  clients call them cross-origin, and they answer CORS. Everything else keeps the browser-origin checks.
- `src/middleware.js` forwards the two well-known paths to Django; the gateway allows their preflights.

## Board API

`/api/v1/boards` is the item-level REST view of a board for scripts and integrations (`apps/canvas/api_v1.py`,
`board_items.py`). It adds no auth scheme: the bearer tokens are the existing agent tokens (personal access tokens
and OAuth access tokens from Settings, Agent access), with the same per-user opt-in and revocation. Session
cookies are refused. Two scopes: `veevee.boards.read` and `veevee.boards.write`. A token acts as its user, so board
roles decide: a viewer or commenter token reads but never writes, whatever its scopes.

| Method and path | Scope | Purpose |
|---|---|---|
| `GET /api/v1/boards` | read | Boards the user can see, with role |
| `GET /api/v1/boards/{id}` | read | One board's summary |
| `GET`, `POST /api/v1/boards/{id}/items` | read, write | Page nodes (`type`, `cursor`, `limit`); create one or a bulk batch (50 at most, all or none) |
| `GET`, `PATCH`, `DELETE /api/v1/boards/{id}/items/{itemId}` | read, write | One node |
| `GET`, `POST /api/v1/boards/{id}/connectors` and `.../connectors/{itemId}` | read, write | Same for connectors |
| `GET /api/v1/boards/{id}/changes?since=<version>` | read | Polled change feed, standing in for webhooks |

Rate limits are credit based: one budget per grant (`policy.BOARD_CREDITS`), spent per call by cost level
(`policy.BOARD_COSTS`: read 10, list 50, write 100, bulk 500). Every response carries `X-RateLimit-Limit`,
`X-RateLimit-Remaining` and `X-RateLimit-Reset`; an exhausted budget is 429 with `Retry-After`, and the refused
call still counts. The MCP board tools spend the same credits.

## Interface for the MCP service

```python
from django.db import transaction
from apps.mcp_auth.principal import authenticate_bearer, AuthenticationError, AgentAccessDisabled
from apps.mcp_auth import controls

principal = authenticate_bearer(request.headers.get('Authorization'))  # AuthenticationError -> 401 with challenge
principal.require('veevee.generate')                                   # InsufficientScope -> 403 with challenge
controls.check_rate(principal, 'calls')                                # RateLimited
decision = controls.price_decision(principal, cost_cents)              # 'submit', 'quote' or 'confirm'
with transaction.atomic():
    controls.admit_paid_submission(principal, cost_cents)              # BudgetExceeded / RateLimited / ConcurrencyLimit
    generation = submit(..., **principal.origin_fields())              # created_via='mcp' ('agent' for a grant), mcp_token_id, mcp_client_id
with controls.hold_slot(principal):                                    # at most 4 waiting calls per grant
    ...
```

- `AuthenticationError.www_authenticate()` gives the `WWW-Authenticate` value with `resource_metadata` and
  `scope`; `AgentAccessDisabled` (the user's opt-in is off) is a tool error `MCP_DISABLED`, not an HTTP 401.
  The MCP service checks scopes with `principal.has_scope` and answers a missing one as the tool error
  `INSUFFICIENT_SCOPE`.
- `admit_paid_submission` takes a per-user advisory lock, so parallel calls cannot pass the user or grant cap.
  Spend is the trailing 24 hours of agent-created rows (`created_via` in `policy.AGENT_ORIGINS`; reconciled cost
  when known, else the estimate; `cancelled_before_submission` rows are free). Pass `controls.booked_cents(...)`: for Seedance 2.5 it is the
  higher of the estimate and the paid guard's current token estimate, and spend counts an unfinished estimated
  Seedance 2.5 row at that amount until it reconciles.
- Rate windows and hold slots live in `mcp_rate_windows` (no Redis). `GET /api/mcp/me` exercises the same
  authentication over HTTP for checks and tests.
- `apps.mcp_auth.maintenance.purge_expired()` (or `manage.py purge_mcp_auth`) deletes expired codes, rate
  windows, old tokens and unused registered clients; the MCP service runs it in its own maintenance loop.

## Schema

One additive migration set: `mcp_auth.0001_initial` (the four tables) and `generation.0008_generation_mcp_origin`
(nullable `created_via`, `mcp_token_id`, `mcp_client_id`, no backfill, and a partial per-grant spend index).
`MIGRATION_ROWS` accepts 69 and 70, and 71 for the MCP service's `generation.0009_generation_url_lookup` (a
`generations.url` hash index built concurrently, `mcp-server.md`).
