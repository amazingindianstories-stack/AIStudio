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
  enforced only by the worker's `check_step` and by `check_budget`, so MCP admission has no account-wide
  serialization point. `check_budget` runs before each Agents tab Gemini call outside a run step (voice
  transcription, PDF describe, `view_media`, `read_document`) against the user, grant and global daily caps; once
  one has no cent left, nothing is sent and the call fails `BUDGET_EXCEEDED` (HTTP 429 from `.../messages` and
  `.../transcribe`).
  Settings, Agent access shows the same `spent_cents` total as the user's spent today.
- Agents tab limits (`apps/agents/limits.py`, all in `LIMITS` and `src/lib/limits.js`): `agentActiveRuns` (2),
  `agentMaxStepsPerRun` (40), `agentMaxRunCostCents` (1000), global-only `agentGlobalDailyCapCents` (20000) and
  `agentMaxConcurrentRuns` (8), and attachment limits `agentAttachMaxMb`, `agentAttachMaxVideoSeconds`,
  `agentAttachMaxAudioSeconds` plus 1/0 switches `agentAttachImages`, `agentAttachDocuments`, `agentAttachVideo`,
  `agentAttachAudio`. A per-user row overrides the global value. They are not composer settings.
- Run creation (`check_run_admission`) checks only `agentsEnabled` and `agentActiveRuns`; a run is created queued
  even when `agentMaxConcurrentRuns` runs are running. The worker claim enforces that cap atomically: it claims only
  the first `agentMaxConcurrentRuns` global slot leases (at most 8), read at each claim.
- `agentsEnabled` (1/0): a global 0 is a kill switch, off for everyone including admins and per-user overrides.
  Otherwise a per-user row decides, then a global 1 (on for all), and with nothing set it is on for admins only.
  The dashboard omits the key while no global row exists, and `POST /api/admin/limits` with `value: null` deletes
  the global row to return to admins only (the Limits tab's "Reset to default"). The same switch gates the direct
  Gemini endpoints: `POST .../messages` and `POST .../transcribe` answer `403 AGENTS_DISABLED` before any PDF read,
  transcription or chat turn.
- Mid-run, `check_step` returns a `LimitHit` (`disabled`, `steps`, `run_cost`, `daily_cap`, `grant_daily_cap` for
  the Agents tab grant's own `daily_cap_cents`, `global_daily_cap`).
  `apply_limit_hit` pauses the run (`paused_limit`, `pause_reason` = kind, `resume_after` from the oldest rows
  that free enough of the trailing window, at the latest when every counted row has aged out; one minute later for
  disabled; none for step and run-cost). The switch and the daily caps are waits, never refusals: each hit pauses the
  run (again, with a fresh `resume_after`, however often it recurs, before or after a resume) and never fails it, so a
  run paused by the switch resumes within a minute of an admin turning agents back on. A paid call that alone costs
  more than a daily cap is refused to the model instead (see Step boundaries). Per-run bounds (`steps`, `run_cost`)
  are refusals, recorded in `agent_runs.error.hits`: a second one of the same kind ends the run `failed` with
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

## Agents tab runs

Every Agents tab message goes to a durable run (`agent_runs`) that the `agent` worker advances in the background,
so a turn survives a closed tab, a deploy or a worker crash. The old synchronous turn (`POST .../messages`, one short
tool loop inside the request) is gone; only `PATCH .../messages/<id>` remains, which links a generated item to an
older `design_prompt` reply. Code lives in
`apps/agents`: `runs.py` (the services the views adapt), `runner.py` (the state machine), `worker.py` (claim,
heartbeat and the scheduler's resume pass), `events.py`, `limits.py` and `design.py`.

```
queued -> running -> waiting_approval | waiting_jobs | paused_limit -> completed | failed | cancelled
```

- **Steps.** Every step is journaled in `agent_run_steps` before it runs. An `llm` step is one Gemini call through
  `loop_llm.AgentLoopTransport` with `loop_body(...)` (the pinned models, payload allowlist and `agent_llm_usage`
  ledger). A `tool` step is one model function call, dispatched in-process with `server.dispatch` as the run's grant
  (re-checked before every step) with idempotency key `<run id>:<step index>`, tags `runId` and `stepIndex`. The next
  action is always derived from the journal: after a crash an `llm` step without an outcome is re-issued, and a `tool`
  step without an outcome is replayed with the same key, which returns the first receipt instead of paying twice.
- **Paid tools never wait.** `generate_image`, `generate_video`, `upscale_media` and `finalize_draft` are sent with
  `wait=false`. Each job they create gets `generations.agent_run_id`, `created_via='agent'` and an `agent_chat_assets`
  output row; the run then sits in `waiting_jobs` until every linked job is terminal (rechecked each worker tick) or
  the artist sends a message, and the model is told how the jobs finished.
- **Location.** A job-creating tool (`generate_image`, `generate_video`, `upscale_media`, `finalize_draft`) that got
  neither a folder nor a project lands in the chat's `default_folder_id`, else its `default_project_id`. A folder the
  model names (from `list_folders`) is kept. Other tools that take a location, such as `search_generations`, keep the
  model's scope.
- **Prompt design.** `design_prompt` is the harness's own tool, declared after the registry tools and accepted by the
  loop allowlist only with its exact declaration. It is a tool step that never reaches the dispatcher: one prompt-design
  sub-call through the same transport (usage purpose `design_prompt`) with the old orchestrator's prompt craft and three
  modes: text (no references), edit (one reference plus the instruction) and references (ordered `referenceIds`, cited
  `@img1..@imgN` by position, at most the target model's `maxReferenceImages`).
- **Approvals.** A `quote_required` result parks the run in `waiting_approval` and emits `quote_required` with the
  price, tool, arguments and prompt. Approving stores the approval on the step; the worker replays the same step with
  `quoteToken`, plus `confirmedByUser` at 100 cents or more. Declining, or sending a new message instead, ends the step
  unpaid with `QUOTE_DECLINED` for the model. The model can never send `idempotencyKey`, `quoteToken`,
  `confirmedByUser`, `wait` or `maxWaitSeconds` (removed from its schemas and its calls; `declarations.harness_arguments`
  sets them).
- **Inbox.** A message posted while a run is active goes to `agent_inbox`. At every step boundary, before any bound or
  limit check, the runner delivers undelivered rows in `created_at`/id order as user turns before the next model call,
  setting `delivered_at` and `delivered_step`, adding the message to the chat and emitting `message_delivered`, so a
  message reaches the chat history even when the run then pauses. A run that ends `cancelled` or `failed` delivers any
  message still waiting the same way, so it stays in the chat; no new run starts for it. A message wakes a run waiting
  on jobs or paused at a limit, and a run does not complete while a delivered message is newer than the model's last
  turn.
- **Attachments.** A run message may carry `attachments` (up to 10 document upload ids, each the caller's ready
  document upload) and `images` (stored reference image URLs that resolve to the caller's ready upload or to any
  finished image generation of the shared library, a teammate's included, as `view_media` reads it; a data URL is
  refused, so the composer uploads it first, and so is a protected key). Each file is loaded once to validate it, recorded
  in `agent_chat_assets` with the run, and stored as `{id, kind, name}` on the chat message or inbox row (`attachments`
  in the message and inbox JSON). Nothing is read for the model at send time: its turn gets one note naming each file
  by kind, id and quoted filename, and it opens them with `read_document` or `view_media`.
- **Step boundaries.** Before each step the runner stops if its lease was lost or the worker is stopping (the run goes
  back to `queued`), honours a cancel request, re-checks the grant (`AgentGrantInvalid` fails the run), delivers the
  inbox, and checks the limits with `limits.check_step`, read at call time (the `agentsEnabled` switch, which is how to
  stop runs during a maintenance write freeze since the runner does not observe it yet; `agentMaxStepsPerRun`;
  `agentMaxRunCostCents` with the run's model token spend; and the user, grant and global daily caps), then the
  active-time bound. A hit goes through `apply_limit_hit` (above). `time_limit` pauses the run at 2 hours spent inside
  steps, where each step counts from its latest attempt to its outcome, so waiting for approval, jobs or a limit is not
  counted. A message wakes a paused run and is delivered to the chat; a run still at `steps` or `run_cost` then fails
  as a second refusal, while a run at `disabled` or a daily cap only ever pauses again. Stopping it keeps its jobs. A paid
  call whose price (or approved quote) would alone take the run past `agentMaxRunCostCents` is never sent and not
  retried: it is journaled as its own tool step with outcome `COST_LIMIT` and a `COST_LIMIT` function response
  (nothing was charged; suggest a cheaper option or ask the artist), and the model's next turn can explain or offer a
  cheaper option. Every over-bound call in one model turn is refused this way; one in a later turn, after the model
  was told, fails the run with error code `limit` (`kind` `cost`). A paid call (or approved quote) that alone costs
  more than the user, grant or global daily cap, so no wait in the trailing window frees it, is refused the same way
  with outcome and response code `BUDGET_EXCEEDED`; asking again after being told fails the run with `limit` and the
  cap's kind. The run pauses only for a daily cap the window frees. A step already sent is replayed with its key rather
  than refused, so a job it submitted is never lost; a replay adds no step to the step limit, and every other limit
  still applies to it.
- **Cancel.** A stop request sets `cancel_requested_at`; the run ends `cancelled` at its next step boundary, and jobs
  already queued finish normally. "Stop and cancel jobs" (`cancel_jobs`) also cancels every active linked job through
  `generation/services/cancellation.cancel_generation` (deferred, so the generation worker sends any provider cancel).
  Deleting a conversation deletes its runs with it (the database cascade), so a run still active stops counting and is
  not advanced again; jobs it already queued finish into the library. A step in flight at the delete ends quietly in the
  worker, and its Gemini call is still recorded in `agent_llm_usage`, without its conversation and run.
- **Events.** `agent_run_events` carries a gapless, strictly increasing per-run `seq`, allocated under the run row lock:
  `run_queued`, `run_started`, `resumed`, `step_started`, `tool_called`, `job_queued`, `job_finished`, `waiting_jobs`,
  `quote_required`, `quote_approved`, `quote_declined`, `message_queued`, `message_delivered`, `assistant_text`,
  `paused`, `cancel_requested`, `completed`, `failed` and `cancelled`. The final model text also becomes an assistant
  `agent_conversation_messages` row. A terminal status is written with its final event.

| Method and path (under `/api/agent-conversations/<id>`) | Purpose |
|---|---|
| `GET .../runs` | The chat's 20 most recent runs |
| `POST .../runs` `{content, model?, attachments?, images?}` | Starts a run with the message (201), or writes it to the active run's inbox (202). One active run per conversation is a database constraint. `403 AGENTS_DISABLED` when the Agents tab is off for the caller, even with a run active; when no run is active, `429 AGENT_LIMIT` (with `kind` `active_runs`) at the `agentActiveRuns` cap |
| `GET .../runs/<run>/events?after=<seq>&limit=` | Up to 100 events after `seq`, with the run, `nextAfter`, `more` and the undelivered messages |
| `POST .../runs/<run>/approve`, `.../decline` `{stepIndex}` | Answers the waiting quote; `409 NO_PENDING_QUOTE` otherwise |
| `POST .../runs/<run>/cancel` `{cancelJobs?}` | Stop (202), or stop and cancel the run's active jobs; `409 RUN_FINISHED` once it ended |

Every agent-conversation route (conversations, messages, transcription and runs) needs a session for which
`limits.agents_enabled` is true, else `403 AGENTS_DISABLED` (`403 FORBIDDEN` without a session); `GET /api/auth/me`
returns the same boolean as `user.agentsEnabled`, which opens the Agents tab in the top bar. Everyone, admins
included, lists and opens only their own conversations; another user's conversation or run is 404. The gateway
opens starting a run and approving a quote only with its paid routes on (`paid_initial_routes`); the events feed,
decline and cancel are always open.

### Agents tab UI

`src/components/StudioChat.jsx` sends every message to `POST .../runs` with `content`, the staged document upload ids
(`attachments`) and the reference images (`images`; data-URL references are uploaded first and written back to the
draft). Voice notes are transcribed into the composer before sending, so they take the same path. A 201 shows the
saved message and follows the new run; a 202 shows the inbox row as a dashed "Queued" bubble until `message_delivered`
arrives, or a `pendingMessages` snapshot read after its `message_queued` no longer lists it. A refused send keeps the
draft and staged files and shows the API's message (`AGENTS_DISABLED`, `AGENT_GRANT_INVALID` and the rest).

- **Feed.** `src/lib/agent-run.js` is pure: `applyPage` keeps events by `seq` (duplicate, out-of-order and repeated
  pages change nothing; the cursor only advances over gapless seqs), `drainFeed` follows `more`, and `runView` builds
  the timeline (model text, tool steps keyed by `stepIndex` with their status, outcome code and summary, the jobs each
  step queued, delivered messages), the pending quote, the pause, the stop request and the outcome. A stop that
  cancelled jobs marks them cancelled. `src/components/useAgentRun.js` polls `events?after=<cursor>` every 1.5 s while
  the run works and every 5 s while it waits for approval or a limit, doubling per failure up to 30 s; after three
  failures in a row it says it lost touch, and a 403 or 404 stops it. Once the run is terminal and `more` is false it
  re-reads the conversation, so the saved thread becomes authoritative.
- **Thread.** `threadEntries` in `src/lib/agent-run.js` places each run's activity after the message that started it
  (`run_queued` `messageId`); `src/components/AgentRunPanel.jsx` renders it. A run's saved replies (assistant messages
  with `toolTrace.runId` and `stepIndex`) and the messages it read from its inbox (user messages with `runId` and
  `deliveredStep` in the conversation JSON) show as saved messages, so the feed items they repeat are left out and the
  activity between them is split into segments, each after the saved message it follows. The activity is tool steps,
  jobs (a succeeded job shows its `MediaCard`, read by id through the store's `loadItem` when no loaded scope holds it;
  a running one shows `GenerationStatus`, a failed or cancelled one its text), non-final text, and, in the run's last
  segment, queued messages, the quote, pause card, status line and how a failed or stopped run ended. While the run is
  live and the thread has not been re-read, its replies and the messages it read come from the feed.
- **Reconnect.** Opening a conversation reads `GET .../runs` (the 20 most recent). An active run resumes from the state
  saved in `sessionStorage` (`veevee.agentRun.<run id>`: the gapless events, cursor and queued rows, written after every
  poll in try/catch), so a reload polls from the last seq with nothing duplicated; a missing or damaged save reads from
  0. Every run that ended is read once from its feed (`drainFeed`, at most 20 pages) and never polled; the tab keeps
  ended feeds in memory, so switching back to a chat reads nothing again. A send follows the run it started (or shows
  the message it queued) only while its chat is still open, and a run it replaces before that run's feed was drained
  is drained once and stays in the thread.
- **Quote card.** Shows the tool, the cost (`display`, else dollars from `costCents`), the summary, the prompt and the
  scalar arguments, with Approve and Decline. Approving is always a click; at 100 cents or more it first asks for
  "Confirm $X" and only then sends `{stepIndex}` (the API needs no confirm field; the worker adds `confirmedByUser`).
  `409 NO_PENDING_QUOTE` shows "This quote is no longer waiting for approval."
- **Pause, failure and stop.** The pause card gives the `pause_reason` in plain words and when the run tries again
  ("in N minutes" within the hour, else the local time). A failed run shows its error message; a cancelled one says
  whether its jobs keep running or how many the stop cancelled. While a run is active the status line offers "Stop"
  (`cancelJobs: false`) and "Stop and cancel jobs" (`true`), then shows "Stopping…" after `cancel_requested` until
  the run ends; `409 RUN_FINISHED` is not shown as an error.
- **Tests.** `src/lib/agent-run.test.js` covers the reducer and helpers. `tests/browser/agents-runs.spec.mjs` drives
  the tab against Django with no agent worker: the composer starts a real run and the spec writes the worker's events
  and run status through `fixture-db.mjs` (feed rendering, delivered message, reload from the last seq, quote approve
  with the second confirmation and decline including a 409, the pause card, Stop and cancel jobs, a failed run, a succeeded job's media card read by id, and the activity of a completed run and an earlier failed run in order
  after a reload, each feed read once, a run replaced before its feed was read, and a send answered after a chat
  switch).

The worker is its own Railway component, `python -m deploy.entrypoint agent`, which runs
`agent_worker --interval 1 --concurrency N` (`VEEVEE_AGENT_WORKER_SLOTS`, 1 to 8, default 4). It uses the API's
database role and API-style configuration (`deploy/legacy_config.py` `_agent`) with `GOOGLE_API_KEY` as its only
provider key (`AGENT_KEYS`; no BytePlus, Kling or Magnific keys, portrait or Web Push settings, ingress secret or
port), plus its own `MCP_QUOTE_SECRET` (32+ characters), because it signs and checks quotes in-process. It advances a
run only while it holds the run's lease and one of the first `agentMaxConcurrentRuns` (at most 8) global slot leases
(`apps.common.leases`), renewed every 15 s
with the run's `last_heartbeat_at`. The scheduler's `agent_runs` pass re-queues a `running` run whose heartbeat is
older than 60 s, and the next worker resumes it from its journal. The worker never blocks on a provider.

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
