# ComfyUI Workflow Documentation

**Status:** living document — new workflows get appended to §6 (Catalog) and logged in §11.
**Owner:** Veevee (`image-video-project`)
**Started:** 2026-07-29
**Scope of this revision:** the workflow set required to make the project chat a real,
two-way, LLM-backed conversation with per-project system instructions and knowledge,
served by a local ComfyUI rather than a hosted API.

---

## 1. What this document is

Every ComfyUI graph this app depends on is specified here: its purpose, its exact
input/output contract, the nodes it is built from, its high-level design, and the
failure modes it has to survive. A workflow is not "done" until it has an entry here
and a versioned `.api.json` file in `comfy/workflows/`.

This is deliberately a single long document rather than one file per workflow. The
workflows share a calling contract, a streaming mechanism, and a model backend; those
shared parts (§4, §5) are the bulk of the engineering, and splitting them across files
is how they drift.

**Not in scope here:** the image/video generation providers (Nano Banana Pro,
Higgsfield, Seedance, Omni). Those stay on their existing HTTP paths — see `CLAUDE.md`.
ComfyUI is being introduced for the *language* layer only. Whether image generation
eventually migrates onto ComfyUI too is an open question (§10, B7), not an assumption.

---

## 2. The architecture decision this rests on

### 2.1 ComfyUI is the orchestration plane, not the inference server

ComfyUI is a node-graph execution engine with a job queue and an HTTP/WebSocket API.
It is excellent at *composing* steps and terrible at *serving a chat token stream*,
because its `/prompt` endpoint is job-shaped: you enqueue a graph and wait for it to
finish. There is no native "stream me tokens as they are produced".

`docs/llm-prompt-generation-research.md` (2026-07-16) reached the same conclusion and
recommended serving the model behind an OpenAI-compatible HTTP interface. This document
does not contradict that; it splits the responsibility:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Next.js app (Vercel)                                                        │
│    /api/chat/*  ── provider-neutral contract ──┐                             │
│                                                │                             │
└────────────────────────────────────────────────┼─────────────────────────────┘
                                                 │  HTTPS + bearer token
                                                 │  (Cloudflare Tunnel — §3.3)
┌────────────────────────────────────────────────▼─────────────────────────────┐
│  Workstation (M1 Ultra, 64 GB) — private network                             │
│                                                                              │
│   ComfyUI :8189  "LLM instance"        ← ORCHESTRATION PLANE                 │
│     • holds the workflow graphs (§6)                                         │
│     • no diffusion checkpoints loaded                                        │
│     • one queue, chat-only, so an image job can never block a chat turn      │
│              │                                                               │
│              │  HTTP (OpenAI-compatible /v1/chat/completions, /v1/embeddings) │
│              ▼                                                               │
│   Model server :11434 / :8080          ← INFERENCE PLANE                      │
│     • MLX-VLM  (Apple Silicon)  or llama.cpp  or Ollama  or vLLM             │
│     • Qwen3-VL-8B / 30B-A3B  (per the research doc's candidates)             │
│     • owns weights, KV cache, batching, streaming                            │
│                                                                              │
│   Postgres (existing, Railway/Cloud SQL) + pgvector                          │
│     • chat threads, messages, project knowledge, embeddings (§7)             │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Why the model does not live inside ComfyUI's process:** VRAM/unified-memory
contention. A resident 30B-A3B at 4-bit is ~18 GB. If ComfyUI ever also runs a
diffusion graph on the same instance it will evict the LLM, and the next chat turn
pays a 20–40 s cold load. Keeping the weights in a separate always-warm server makes
chat latency predictable and lets us restart/edit ComfyUI freely.

**What ComfyUI genuinely buys us in return:** the graphs in §6 are editable by a
non-engineer, versionable as JSON, and composable — the prompt-builder workflow (W3)
can be extended with a retrieval branch, a critique branch, or a downstream image node
without touching TypeScript. That is the reason to accept the extra hop.

### 2.2 Streaming is solved with one custom node, not by giving up

ComfyUI custom nodes can push arbitrary messages to connected clients via
`PromptServer.instance.send_sync(event, data, sid)` — the same mechanism the built-in
`progress` and `executing` events use ([ComfyUI server comms docs](https://docs.comfy.org/development/comfyui-server/comms_overview)).
So `VeeveeStreamSink` (§5.4, ours) consumes the model server's SSE stream and re-emits
each delta as a `veevee.token` websocket event tagged with the `prompt_id`. The Next.js
adapter holds one websocket to ComfyUI and relays those deltas to the browser as SSE.

This is the single most important piece of custom code in the whole integration. If it
is not built, every chat turn is a 5–30 s blank wait, and the feature will feel broken
regardless of model quality.

### 2.3 Honest constraints, stated up front

| Constraint | Consequence |
|---|---|
| Vercel cannot reach a workstation on a home/office LAN | A tunnel with auth is mandatory (§3.3). No tunnel, no chat in production. |
| ComfyUI has one queue per instance and runs one prompt at a time | Dedicated LLM instance (§3.1). Sharing with image gen serialises chat behind 60 s renders. |
| ComfyUI has no authentication of its own | Never expose the port. Auth happens at the tunnel and is re-checked by our adapter. |
| Community node packs are executable third-party code | Pin by commit, audit before install (§3.4). |
| A workstation is not an SLA | `LLM_BACKEND` must support a hosted fallback and a `mock` mode from day one (§7.4). |
| `@tag` syntax is a binding contract in `prompt-assembler.ts` | Every workflow that emits a generation prompt must preserve `@imgN` / `@slug` tokens verbatim. Enforced by schema validation (§5.5), not by hope. |

---

## 3. Runtime topology

### 3.1 ComfyUI instances

| Instance | Port | Purpose | Models loaded |
|---|---|---|---|
| `comfy-llm` | 8189 | Every workflow in §6 | none (all inference is remote HTTP) |
| `comfy-media` *(future)* | 8188 | Reserved for a possible local diffusion path (§10, B7) | SDXL/Flux etc. |

Launch flags for `comfy-llm`: `--port 8189 --listen 127.0.0.1 --disable-auto-launch
--cpu` — `--cpu` is correct and deliberate: this instance runs no tensor work, it only
makes HTTP calls, so it should not reserve any accelerator memory at all.

### 3.2 Model server

Chosen per the research doc's candidate table. Start with:

| Role | Model | Server | Why |
|---|---|---|---|
| Chat / prompt-writing | `Qwen3-VL-8B-Instruct` (4-bit) | MLX-VLM | Multimodal, fast on M1 Ultra, the doc's "test first" pick |
| Quality escalation | `Qwen3-VL-30B-A3B-Instruct` (4-bit) | MLX-VLM | ~3B active params/token; the doc's primary open challenger |
| Utility (titles, summaries, classification) | `Qwen3-4B-Instruct` | llama.cpp | Sub-second; must not queue behind the big model — run it on its own port |
| Embeddings | `bge-m3` or `Qwen3-Embedding-0.6B` | llama.cpp `--embedding` | Dimension must be fixed before W4 runs; changing it means a full re-index |

The utility model on a separate port is not an optimisation — W6/W7 fire *during* a
chat turn, and if they share the chat model's queue they add their latency to the
user-visible response.

### 3.3 Exposure

Cloudflare Tunnel (or Tailscale Funnel) → `https://comfy-llm.<internal-domain>`, with:

- Cloudflare Access service token, or a static bearer checked by a tiny reverse proxy.
- Our adapter *also* sends `COMFY_LLM_TOKEN`; the tunnel auth and the app auth are
  independent layers, and neither is allowed to be the only one.
- Allowlist exactly three upstream paths: `POST /prompt`, `GET /history/*`, `GET /ws`.
  `POST /queue`, `POST /interrupt` are needed for cancellation (§4.7) — allow those two
  as well but nothing else. In particular `/upload/image`, `/view`, `/system_stats`,
  `/object_info`, and the whole web UI stay unexposed; images reach the workflow as
  signed URLs from our own media proxy (§4.4), never by upload to ComfyUI.

### 3.4 Node packs

| Pack | Pinned to | Used by | Audit note |
|---|---|---|---|
| `comfyui-veevee-nodes` *(ours, in-repo)* | this repo, `comfy/nodes/` | all | Reviewed as normal app code |
| [`comfyui-ollama`](https://github.com/stavsap/comfyui-ollama) | commit pin | prototyping only (§5.2 alternative) | Small, readable, no network beyond Ollama |
| [`comfyui_LLM_party`](https://github.com/heshengtao/comfyui_LLM_party) | commit pin | evaluated for W4/W5 only | **Large surface, many outbound integrations.** Not adopted in v1 — see §6.4 note |

Rule: a pack is installed by pinned commit in a checked-in `comfy/requirements.lock`,
never by "install latest from Manager" on the workstation. A ComfyUI graph is code
execution; an unpinned pack update is an unreviewed deploy.

---

## 4. Global conventions (every workflow obeys these)

### 4.1 File naming and versioning

```
comfy/workflows/W1_chat-completion.v3.api.json     ← executed by the app
comfy/workflows/W1_chat-completion.v3.ui.json      ← editable graph, for humans
comfy/workflows/README.md                          ← points here
```

- **Both** exports are committed. The `.api.json` is what `POST /prompt` accepts; the
  `.ui.json` is the only one you can reopen and edit in the ComfyUI canvas. Committing
  only the API export makes the graph effectively read-only forever.
- Version is bumped on **any** change to node structure or the input/output contract.
  Prompt-text-only edits bump the version too — a prompt is behaviour.
- The app pins the version it calls in code (`W1_VERSION = 3`). It never globs for
  "latest". A workflow edited on the workstation must be committed and deployed to take
  effect, exactly like a code change.

### 4.2 Placeholder binding — by title, never by node id

Node ids in an API export are integers that renumber when the graph is edited. Binding
on them produces a class of bug where the workflow still runs but silently reads the
wrong string. So every injectable input node carries a `_meta.title` of the form
`VEEVEE_IN::<key>`, and the adapter walks the JSON:

```ts
// comfy/bind.ts — sketch
function bind(graph: ComfyGraph, values: Record<string, unknown>) {
  const found = new Set<string>();
  for (const node of Object.values(graph)) {
    const title = node._meta?.title ?? "";
    if (!title.startsWith("VEEVEE_IN::")) continue;
    const key = title.slice("VEEVEE_IN::".length);
    if (!(key in values)) throw new Error(`workflow expects input "${key}"`);
    node.inputs.value = values[key];
    found.add(key);
  }
  const extra = Object.keys(values).filter((k) => !found.has(k));
  if (extra.length) throw new Error(`workflow has no slot for: ${extra.join(", ")}`);
}
```

Both directions throw. A missing slot means we'd send a value into the void; an extra
slot means the workflow would run with a stale default. Neither is allowed to be silent.

### 4.3 One JSON input, not twelve string inputs

Every workflow takes **exactly one** required injected value, `VEEVEE_IN::request`, a
JSON string, plus at most one optional `VEEVEE_IN::debug`. `VeeveeRequest` (§5.1) parses
it and fans it out to typed sockets inside the graph.

The alternative — a titled primitive per field — was rejected: adding a field then means
editing the graph, re-exporting, and updating the binder, and every workflow drifts to a
slightly different field set. With one JSON blob the contract lives in TypeScript types
and a JSON Schema, which is where we can actually test it.

### 4.4 Images

Images enter as **HTTPS URLs**, not base64 and not ComfyUI uploads:

- The URL is a short-lived signed link from `GET /api/media/[...path]` (which already
  enforces session auth and blocks the `settings/`/`migrations/` prefixes — see
  `CLAUDE.md` § Media storage).
- `VeeveeFetchImage` (§5.6) fetches with a 10 s timeout, a 20 MB cap, and a
  JPEG/PNG/WebP/GIF MIME allowlist that mirrors `splitDataUrl` in `src/lib/storage.ts`.
- Base64 in the request JSON is forbidden: a 4-reference turn would push the `/prompt`
  body past 20 MB and it would be logged in ComfyUI's history verbatim.

### 4.5 Outputs

Every workflow terminates in exactly one `VeeveeOutput` node (§5.4) whose `ui` payload
lands in `GET /history/{prompt_id}`:

```jsonc
{
  "ok": true,
  "workflow": "W1_chat-completion",
  "version": 3,
  "text": "…final assistant message…",     // present when ok
  "json": null,                             // W3/W8 put their validated object here
  "error": null,                            // { code, message } when ok=false
  "telemetry": {
    "model": "qwen3-vl-8b-instruct-4bit",
    "tokens_in": 1843, "tokens_out": 412,
    "ttft_ms": 380, "total_ms": 6120,
    "retries": 0, "truncated": false
  }
}
```

`ok: false` is a **normal completion**, not a ComfyUI exception. This mirrors the
existing generation routes, which return the failed item as HTTP 200 JSON. A thrown
Python exception inside a node gets us an opaque ComfyUI traceback and no telemetry, so
nodes catch their own errors and emit them into this envelope.

### 4.6 Streaming

`VeeveeStreamSink` emits, over ComfyUI's `/ws`:

| Event | Payload | When |
|---|---|---|
| `veevee.start` | `{prompt_id, workflow, version, model}` | first token requested |
| `veevee.token` | `{prompt_id, seq, delta}` | per SSE delta from the model server |
| `veevee.done` | `{prompt_id, text, telemetry}` | stream closed |
| `veevee.error` | `{prompt_id, code, message}` | stream aborted |

`seq` is monotonic per `prompt_id` so the relay can detect a dropped frame and fall back
to the `/history` result rather than showing a message with a hole in it.

The adapter keeps **one** websocket per server process (a fixed `clientId`), demuxing by
`prompt_id`. One socket per chat turn would exhaust file descriptors under concurrency
and race the enqueue.

### 4.7 Timeouts and cancellation

- Every node that makes an HTTP call takes its timeout from the request JSON
  (`params.timeout_ms`), defaulting to 60 s for chat, 15 s for utility workflows.
- **Cancel a queued turn:** `POST /queue` with `{"delete": ["<prompt_id>"]}`.
- **Cancel a running turn:** `POST /interrupt`. This interrupts *whatever is currently
  running on that instance* — it is not per-prompt. It is only safe because `comfy-llm`
  is chat-dedicated (§3.1); before calling it the adapter re-reads `/queue` and confirms
  the running prompt is the one it means to kill.
- The browser aborting an SSE stream must trigger cancellation server-side. Otherwise a
  user who closes the tab leaves a 30 s generation occupying the single queue slot.

### 4.8 Determinism and caching

- ComfyUI caches node outputs across runs when inputs are identical. For chat this is
  *wrong* — a re-asked question would replay a cached answer. Every workflow therefore
  includes a `nonce` field in the request JSON, wired into `VeeveeRequest`, so the graph
  hash differs per turn.
- Except where we want caching: W4 (ingest) and W8 (asset describe) deliberately keep a
  stable nonce derived from a content hash, so re-running over unchanged content is free.

### 4.9 Telemetry is not optional

Every turn writes `model`, `workflow`, `version`, `tokens_in/out`, `ttft_ms`, `total_ms`
to `chat_messages` (§7.1). The research doc's fine-tuning plan (Phase 4) depends on
exactly these fields plus the human-edit signal. Adding them later means the first
months of real usage produce no training data, which is the expensive kind of mistake.

### 4.10 Safety rules carried over from existing code

- **Never trigger a paid image/video generation from an assistant response.** The
  assistant proposes a spec (W3); a human presses Generate. This is the same rule the
  research doc set, and it is what keeps a prompt-injected knowledge file from spending
  money.
- **Health checks must be side-effect-free.** W9 exists precisely so the admin Status
  tab never has to run a real chat workflow to prove liveness — the same discipline as
  the Higgsfield token check in `status-checks.ts`.
- **Knowledge and asset text are untrusted input.** They are wrapped in delimiters and
  labelled as data in the system prompt (§5.3); they never get concatenated as
  instructions.

---

## 5. Shared components

These are the reusable pieces. `(ours)` = custom node we write and review in-repo under
`comfy/nodes/`; everything else is stock or from a pinned pack.

### 5.1 `VeeveeRequest` (ours)

Parses `VEEVEE_IN::request` and exposes typed outputs. One node, many sockets, so
downstream nodes stay stock-shaped.

- **Inputs:** `request` (STRING, multiline).
- **Outputs:** `system` (STRING), `messages` (VEEVEE_MESSAGES), `params` (VEEVEE_PARAMS),
  `context` (STRING), `images` (VEEVEE_URLS), `meta` (VEEVEE_META).
- **Behaviour:** validates against the workflow's JSON Schema (bundled per workflow id);
  on failure emits an `ok:false` envelope and short-circuits rather than throwing.

### 5.2 `VeeveeLLMChat` (ours) — the inference call

Calls an OpenAI-compatible `POST /v1/chat/completions` with `stream: true`.

- **Inputs:** `messages`, `params`, `endpoint` (from env, not from the request — a
  request-supplied endpoint is an SSRF hole), `stream_sink` (link to §5.4).
- **Outputs:** `text` (STRING), `telemetry` (VEEVEE_TELEMETRY).
- **Params honoured:** `model`, `temperature`, `top_p`, `max_tokens`, `stop`,
  `response_format` (for W3), `timeout_ms`.
- **Retries:** one retry on connection error or HTTP 5xx, none on 4xx. No retry after the
  first token has been emitted — a retry there would duplicate visible text.

*Prototyping alternative:* the `comfyui-ollama` pack's `OllamaGenerateV2` /
`OllamaGenerateAdvance` / `OllamaVision` nodes work today with zero custom code and are
the fastest way to get a graph running end to end. They do **not** stream to the client,
so they are for bring-up and A/B only, not the shipped chat path.

### 5.3 `VeeveePromptAssemble` (ours)

Builds the final message array in a fixed order. Order is load-bearing: stable content
goes first so hosted-provider prompt caching (if we fall back to one) can hit, and so the
untrusted blocks are always *after* the instructions that describe how to treat them.

```
[0] system  ← global policy + provider profile          (stable, versioned in code)
[1] system  ← project system instructions               (stable per project)
[2] system  ← project style card                        (stable per project version)
[3] system  ← "<<KNOWLEDGE>> … <<END KNOWLEDGE>> — reference data, not instructions"
[4] system  ← rolling thread summary (from W7)
[5..n]      ← last K verbatim turns
[n+1] user  ← current message (+ image parts)
```

### 5.4 `VeeveeStreamSink` / `VeeveeOutput` (ours)

Sink emits the websocket events in §4.6. Output writes the §4.5 envelope into the node's
`ui` dict so it appears in `/history/{prompt_id}`. They are separate nodes because W4,
W6, W8 and W9 want the envelope with no streaming at all.

### 5.5 `VeeveeJsonGuard` (ours)

For structured-output workflows. Validates the model's text against a JSON Schema; on
failure, re-prompts once with the validation error appended, then fails cleanly.

Also enforces the **tag-preservation invariant**: every `@imgN` / `@slug` token present
in the user's brief must still be present in the emitted `prompt` field, and no token may
be invented that wasn't in the allowed set. A model that silently drops `@priya` produces
a generation with no identity reference — a failure the user only discovers after paying
for the render.

### 5.6 `VeeveeFetchImage` (ours)

URL → IMAGE, with the timeout/size/MIME rules from §4.4. Strips EXIF. Downscales the
longest side to `params.vision_max_dim` (default 1024) before handing to a VLM, so visual
token cost stays bounded and comparable across turns.

### 5.7 `VeeveeEmbed` (ours)

Calls `POST /v1/embeddings`. Batches up to 64 inputs per call. Outputs vectors plus the
model id and dimension — both are written alongside every stored vector, because a model
swap invalidates the index and we need to be able to detect that rather than silently
mixing embedding spaces.

### 5.8 `VeeveeTelemetry` (ours)

Merges telemetry from every node that produced any, and stamps `workflow`, `version`,
and wall-clock. Terminal-adjacent; feeds `VeeveeOutput`.

---

## 6. Workflow catalog

Nine workflows for v1. Each entry: purpose → contract → nodes → design → notes.

| ID | Name | Trigger | Streams? | Target p95 |
|---|---|---|---|---|
| W1 | `chat-completion` | user sends a chat message | yes | TTFT < 1.5 s |
| W2 | `chat-completion-vision` | chat message with image attachments | yes | TTFT < 3 s |
| W3 | `prompt-build` | "turn this into a prompt" / Apply to composer | no | < 8 s |
| W4 | `knowledge-ingest` | knowledge file added to a project | no | < 30 s/doc |
| W5 | `knowledge-retrieve` | every W1/W2/W3 turn (embed step) | no | < 250 ms |
| W6 | `thread-title` | first assistant reply in a thread | no | < 1.5 s |
| W7 | `thread-summarize` | thread exceeds context budget | no | < 6 s |
| W8 | `asset-describe` | asset saved to library / role detect | no | < 6 s |
| W9 | `health-ping` | admin Status tab | no | < 800 ms |

---

### 6.1 W1 — `chat-completion`

**Purpose.** One conversational turn. This is the workflow that turns the current
read-only `ConversationPanel` into an actual chat.

**Called by.** `POST /api/chat/threads/[id]/messages` → adapter → `POST /prompt`.

**Contract.**

```jsonc
// request
{
  "workflow": "W1_chat-completion", "version": 3, "nonce": "9f3c…",
  "system": {
    "policy_version": "p7",
    "project_instructions": "You are the art director for …",
    "style_card": "{…versioned project style card…}"
  },
  "context": "<<KNOWLEDGE>>…retrieved chunks from W5…<<END KNOWLEDGE>>",
  "summary": "…rolling summary of turns 1–40 (from W7)…",
  "messages": [ {"role":"user","content":"…"}, {"role":"assistant","content":"…"} ],
  "params": { "model":"qwen3-vl-8b-instruct-4bit", "temperature":0.7,
              "max_tokens":1200, "timeout_ms":60000 },
  "meta": { "thread_id":"…", "project_id":"…", "user_id":"…" }
}
// response envelope: §4.5, with `text` = assistant message
```

**Nodes.**

| # | Node | Source | Role |
|---|---|---|---|
| 1 | `VEEVEE_IN::request` (String primitive) | core | injection slot |
| 2 | `VeeveeRequest` | ours | parse + schema-validate |
| 3 | `VeeveePromptAssemble` | ours | ordered message array (§5.3) |
| 4 | `VeeveeTokenBudget` | ours | trim oldest verbatim turns to fit `n_ctx`; reports whether W7 should run |
| 5 | `VeeveeStreamSink` | ours | websocket token relay |
| 6 | `VeeveeLLMChat` | ours | the streamed inference call |
| 7 | `VeeveeTelemetry` | ours | merge counters |
| 8 | `VeeveeOutput` | ours | final envelope |

**High-level design.**

```
[1] request ──▶ [2] VeeveeRequest ─┬─ system  ──▶ [3] PromptAssemble ──▶ [4] TokenBudget ──┐
                                   ├─ context ──▶ [3]                                       │
                                   ├─ summary ──▶ [3]                                       │
                                   ├─ messages ─▶ [3]                                       │
                                   └─ params ───────────────────────────────────────┐       │
                                                                                    ▼       ▼
                                                                       [6] VeeveeLLMChat ◀──┘
                                                                            │  │
                                                          tokens ──▶ [5] StreamSink ──▶ /ws
                                                                            ▼
                                                              [7] Telemetry ──▶ [8] Output
```

**Design notes.**

- Node 4 (`VeeveeTokenBudget`) is what stops this workflow from failing at turn 60. It
  drops oldest *verbatim* turns, never the system blocks or the summary, and sets
  `telemetry.needs_summary = true` so the app can schedule W7 out-of-band. Summarising
  inline would add 4–6 s to a user-visible turn.
- The retrieved knowledge block is inserted as a *system* message labelled as data, not
  merged into the user's message. A knowledge file that contains "ignore previous
  instructions" must read as quoted text, not as a turn.
- Temperature default 0.7 for conversation. W3 uses 0.2 — do not share one default
  across both; the prompt writer must be near-deterministic.

**Failure modes.**

| Failure | Handling |
|---|---|
| Model server down | one retry, then `ok:false` code `MODEL_UNAVAILABLE`; app falls back per `LLM_BACKEND` |
| Stream stalls mid-message | sink's 20 s inter-token watchdog → `veevee.error`; partial text is persisted with `truncated: true` rather than discarded |
| Context overflow despite node 4 | `ok:false` code `CONTEXT_OVERFLOW`; app forces W7 and retries once |
| User closes tab | app calls `/interrupt` per §4.7 |

---

### 6.2 W2 — `chat-completion-vision`

**Purpose.** Same turn, with images: "why does her hand look wrong here?", "match the
lighting of this frame", or a generated result dragged into the chat.

**Why a separate workflow rather than a branch in W1.** The image path adds fetch,
resize, EXIF strip, and a visual-token budget, and it needs a VLM-capable model that may
differ from the text default. Branching inside one graph means every W1 turn carries dead
nodes and a `bypass` toggle that will eventually be set wrong. Two files, one shared
contract (W2's request is W1's plus `images[]`).

**Contract delta.**

```jsonc
"images": [ { "url":"https://…/api/media/…?sig=…", "tag":"@img1", "role":"character" } ],
"params": { "model":"qwen3-vl-8b-instruct-4bit", "vision_max_dim":1024, "max_images":6 }
```

**Nodes.** W1's set, plus:

| # | Node | Source | Role |
|---|---|---|---|
| 2a | `VeeveeFetchImage` (batched) | ours | URL → IMAGE, allowlist + resize + EXIF strip |
| 2b | `VeeveeVisionParts` | ours | interleave image parts with their `@tag` labels into the user message |

**Design notes.**

- Images are labelled with their `@tag` **in the message text adjacent to the image
  part** ("Image 1 — `@img1` — role: character"). The model must be able to refer to
  references by the same token the generation pipeline uses; an unlabelled image bundle
  is where tag/role mis-binding comes from.
- `max_images` default 6, matching the maximum reference count actually observed in the
  ledger (research doc §"What was measured"). Exceeding it is a validation error, not a
  silent drop — same principle as the 14-image hard limit in `gemini.ts`.
- Reference analyses are cacheable: `VeeveeFetchImage` keys on the media path + content
  hash, so revising a prompt over the same references does not re-pay visual tokens.
  This is the research doc's "store reference analyses" recommendation, at graph level.

---

### 6.3 W3 — `prompt-build`

**Purpose.** Convert a conversation (or a single brief) into a **validated generation
spec** the composer can apply. This is the workflow that makes the chat useful rather
than decorative.

**Called by.** `POST /api/chat/threads/[id]/prompt-build`, and the composer's
"Improve with Vivi" action.

**Contract.**

```jsonc
// request adds:
"target": { "kind":"image", "model":"Nano Banana Pro", "aspect_ratio":"21:9",
            "resolution":"2K", "profile_version":"nbp-v4" },
"available_tags": [ {"tag":"@priya","kind":"character","description":"…"},
                    {"tag":"@img1","kind":"upload"} ],
"params": { "temperature":0.2, "response_format":{"type":"json_schema", "schema":{…}} }

// response envelope `json`:
{
  "intent_summary": "string",
  "reference_roles": [ { "tag":"@img1", "role":"person", "must_preserve":["identity"] } ],
  "prompt": "final generation prompt, @tags preserved verbatim",
  "negative_constraints": ["…"],
  "assumptions": ["…"],
  "warnings": ["reference conflict or missing input"]
}
```

That schema is taken verbatim from `docs/llm-prompt-generation-research.md`
§"Define one structured output contract" — deliberately, so the local path and any
hosted path stay interchangeable and A/B-comparable.

**Nodes.**

| # | Node | Source | Role |
|---|---|---|---|
| 1–4 | as W1 | | |
| 5 | `VeeveeProviderProfile` | ours | injects the versioned profile for `target.model` (reference limits, tag syntax, camera vocabulary, known failure modes) |
| 6 | `VeeveeLLMChat` (non-streaming, JSON mode / grammar-constrained) | ours | |
| 7 | `VeeveeJsonGuard` | ours | schema validate + tag-preservation invariant + one repair retry |
| 8 | `VeeveeOutput` | ours | |

**High-level design — two-pass.**

```
                     ┌──────────── PASS A (grounding, cacheable) ────────────┐
images ──▶ FetchImage ──▶ LLMChat(vision, temp 0.1) ──▶ grounded_facts JSON ─┤
                     └───────────────────────────────────────────────────────┘
                                                                             │
brief + style card + provider profile + available_tags ──────────────────────┤
                                                                             ▼
                                          PASS B: LLMChat(temp 0.2, json_schema)
                                                          ▼
                                                   VeeveeJsonGuard ──▶ Output
```

Pass A extracts only *observable* attributes from the references; Pass B writes the
prompt and is forbidden from asserting identity/wardrobe/location facts absent from Pass
A's output. Splitting them is what makes the grounding cacheable and independently
testable, per the research doc's two-pass recommendation.

**Design notes.**

- `VeeveeProviderProfile` is the boundary that keeps model quirks out of the weights.
  Profiles live in code (`src/lib/prompt-profiles/`) and are injected, so "Omni is 16:9
  or 9:16 only" is a config change, not a retraining problem. Version them; log the
  version with every draft.
- Output is **never auto-generated from**. The app renders it in the composer with
  Apply / Revise / Compare (§4.10).
- Skipping Pass A when there are no images is correct and should be an explicit branch,
  not an empty-image edge case.

---

### 6.4 W4 — `knowledge-ingest`

**Purpose.** Turn a project's knowledge (brief, style guide, character bible, script,
pasted notes) into retrievable chunks — the "custom GPT knowledge" half of the vision.

**Called by.** `POST /api/projects/[id]/knowledge` (background, after upload).

**Contract.**

```jsonc
{ "workflow":"W4_knowledge-ingest", "version":1,
  "nonce":"sha256:<content-hash>",           // stable ⇒ re-ingest of unchanged doc is cached (§4.8)
  "doc": { "id":"…", "project_id":"…", "title":"Character bible v3",
           "mime":"text/markdown", "text":"…full extracted text…" },
  "params": { "chunk_tokens":400, "chunk_overlap":60,
              "embed_model":"bge-m3", "embed_dim":1024 } }
// response `json`: { "chunks":[{ "ord":0, "text":"…", "tokens":388,
//                                "embedding":[…1024 floats…] }], "doc_hash":"…" }
```

**Nodes.**

| # | Node | Source | Role |
|---|---|---|---|
| 1–2 | request + parse | ours | |
| 3 | `VeeveeChunk` | ours | recursive split on headings → paragraphs → sentences; carries `title` + `ord` into each chunk's text (retrieval without provenance is unusable) |
| 4 | `VeeveeEmbed` | ours | batched `/v1/embeddings` |
| 5 | `VeeveeOutput` | ours | returns chunks + vectors |

**Design note — the vector store is Postgres, not ComfyUI.**

`comfyui_LLM_party` ships a full local RAG stack (`embeddings_function`, file/folder
loaders, GraphRAG). It was evaluated and **not adopted for v1**, for one decisive reason:
it would put project knowledge in a second store, on a workstation, outside the Postgres
that already holds projects, assets and generations — with no backup story, no
per-project access control, and nothing tying a chunk's lifetime to the project row that
owns it. Instead:

- ComfyUI computes embeddings and returns them. It stores nothing.
- The app writes chunks + vectors to `project_knowledge_chunks` with pgvector (§7.1).
- Deleting a project deletes its knowledge by foreign key, like everything else.

The pack stays on the evaluated list for GraphRAG experiments (§10, B4), where the graph
structure is genuinely the product rather than an implementation detail.

**Design notes.**

- `embed_model` + `embed_dim` are written to every row. Changing either requires a full
  re-index; the app must refuse to mix (§5.7).
- Extraction (PDF/DOCX → text) happens **app-side before** this workflow, not in ComfyUI.
  Document parsers are a notorious source of RCE and we are not running them inside a
  node pack on a workstation.

---

### 6.5 W5 — `knowledge-retrieve`

**Purpose.** Query-time retrieval feeding W1/W2/W3's `context` field.

**Design note — this workflow is intentionally thin.** ComfyUI's only job is embedding
the query; the ANN search is a pgvector `ORDER BY embedding <=> $1 LIMIT k` in
`src/lib/knowledge-db.ts`. Two reasons: the app can then filter by `project_id` inside
the same query (a retrieval that can cross project boundaries is a data leak, and it must
be enforced in SQL, not in a graph), and a round trip to the workstation for a search we
could do in 5 ms locally is latency we spend on every single turn.

**Contract.** `{ "query":"…", "project_id":"…", "params":{"embed_model":"bge-m3"} }`
→ `json: { "embedding":[…], "model":"bge-m3", "dim":1024 }`

**Nodes.** request → parse → `VeeveeEmbed` → output. Four nodes.

**Notes.**

- Optional reranking (cross-encoder over top-30 → top-6) is a v2 addition (§10, B1) and
  *would* justify a fatter workflow. Not in v1: measure whether plain top-k is
  insufficient first.
- Retrieval also pulls **approved prompt examples** for the project (few-shot), from the
  same store with a `kind='example'` filter. That is the research doc's "few-shot
  examples" mechanism and it costs nothing extra here.

---

### 6.6 W6 — `thread-title`

**Purpose.** Name a thread from its first exchange, so the per-project thread list is
navigable. ChatGPT-equivalent behaviour, and cheap.

**Contract.** `{ "messages": [first user + first assistant], "params": {"model":"qwen3-4b","max_tokens":16,"temperature":0.3} }`
→ `text: "Diwali rooftop campaign — hero stills"`

**Nodes.** request → parse → PromptAssemble (fixed system prompt) → LLMChat → Output.

**Notes.** Runs on the **utility** model server (§3.2) so it never queues behind a long
chat generation. Fire-and-forget: a failure leaves the thread's fallback title (first 40
chars of the user message) and is not surfaced as an error.

---

### 6.7 W7 — `thread-summarize`

**Purpose.** Keep long threads inside the context budget without losing decisions.

**Called by.** A background job when W1 reports `needs_summary`.

**Contract.** `{ "previous_summary":"…", "messages":[…turns to fold in…],
"params":{"model":"qwen3-8b","max_tokens":600} }` → `text: "…new rolling summary…"`

**Design note.** The summary prompt is **decision-oriented**, not narrative: it must
preserve settled art-direction constraints, rejected directions and why, named
assets/tags in play, and open questions. A generic "summarise this conversation" loses
exactly the constraints the user will be annoyed to repeat. This prompt text is part of
the workflow's version.

**Notes.** Never runs inline (§6.1). Summaries are stored on the thread with the
`version` of the workflow that produced them, so a prompt change can be rolled forward by
re-summarising rather than silently mixing two summary styles in one thread.

---

### 6.8 W8 — `asset-describe`

**Purpose.** Auto-describe a saved asset (`assets.description`) and classify its role
(character / outfit / location / object / style).

**Why it earns its place.** Three existing needs collapse into one workflow: asset
descriptions are currently hand-written or empty; `PROMPT_ROLE_DETECT=1` currently spends
paid Gemini calls on role classification (and those calls compete for the very budget
`spend-window.ts` exists to protect); and W3 needs `available_tags` descriptions to bind
tags correctly. A local VLM does all three for free.

**Contract.**

```jsonc
{ "images":[{"url":"…"}, …], "asset":{"name":"Priya","slug":"priya"},
  "nonce":"sha256:<image-hash>",                    // cacheable
  "params":{"model":"qwen3-vl-8b-instruct-4bit","vision_max_dim":1024,
            "response_format":{"type":"json_schema","schema":{…}}} }
// json: { "role":"character", "confidence":0.93,
//         "description":"…observable attributes only…",
//         "immutable_attributes":["…"], "warnings":[] }
```

**Nodes.** request → parse → `VeeveeFetchImage` → `VeeveeVisionParts` → LLMChat (JSON) →
`VeeveeJsonGuard` → Output.

**Notes.**

- "Observable attributes only" is enforced in the system prompt and spot-checked in
  review — a hallucinated attribute in an asset description propagates into every future
  generation that references that tag, which is the worst blast radius in this system.
- Replacing the paid role-detect path is a **follow-up** (§10, B2), gated on measuring
  agreement with the current Gemini classifier. Ship the description use first.

---

### 6.9 W9 — `health-ping`

**Purpose.** Prove ComfyUI + node pack + model server are all alive, for the admin Status
tab, at near-zero cost.

**Contract.** `{"params":{"model":"qwen3-4b","max_tokens":1}}` → `text: "ok"` plus
telemetry carrying the model id and load state.

**Nodes.** request → parse → LLMChat (`max_tokens: 1`, prompt "Reply with: ok") → Output.

**Design notes.**

- Registered in `src/lib/status-checks.ts` as two checks: `comfyui` (can we reach
  `/prompt` and does the graph execute?) and `llm-model` (did the model server answer?).
  They fail independently — "ComfyUI is up but the model server is down" is a different
  page for whoever is on call.
- Must stay **side-effect free and idempotent**: no writes, no index mutation, no token
  exchange. Same discipline as the Higgsfield check (`CLAUDE.md` § Admin API status
  page), which may not be "improved" into something that mutates state.
- 5 s timeout to match the existing per-check race in `status-checks.ts`.

---

## 7. What the app needs alongside these workflows

The workflows are useless without the chat data model the vision requires. Summarised
here so the two are designed together; full design goes in `.council/project-chat/` when
that work starts.

### 7.1 Schema additions (`src/lib/schema.ts` conventions: uuid ids, bigint ms)

```ts
chat_threads          (id, projectId, title, createdBy, createdAt, updatedAt,
                       archived, summary, summaryVersion, summaryThroughMessageId)
chat_messages         (id, threadId, role, content, attachments jsonb,
                       generationId,            // links a turn to what it produced
                       workflow, workflowVersion, model, tokensIn, tokensOut,
                       ttftMs, latencyMs, costCents, editedFrom, accepted, createdAt)
project_knowledge     (id, projectId, title, source, mime, bytes, docHash, createdAt)
project_knowledge_chunks (id, projectId, docId, ord, kind, content,
                          embedding vector(1024), embedModel, embedDim, tokens)
projects.systemInstructions text        // the "custom GPT" instructions
projects.styleCard jsonb, projects.styleCardVersion int
```

Indexes follow the existing keyset discipline (`CLAUDE.md` § Library feed): messages page
on `(thread_id, created_at DESC, id DESC)` — the trailing `id` matters for the same
reason it does in `generations` (several rows can land in one millisecond). pgvector
index: `ivfflat`/`hnsw` on `embedding` **partitioned by nothing** but always queried with
`project_id = $1` in the predicate.

### 7.2 Routes

```
POST   /api/chat/threads                     create thread in a project
GET    /api/chat/threads?projectId=…         list (keyset)
GET    /api/chat/threads/[id]/messages       page messages
POST   /api/chat/threads/[id]/messages       send → SSE stream of assistant reply  (W1/W2)
POST   /api/chat/threads/[id]/prompt-build   structured spec for the composer      (W3)
POST   /api/chat/threads/[id]/cancel         → /queue delete or /interrupt         (§4.7)
POST   /api/projects/[id]/knowledge          upload + extract + ingest             (W4)
PUT    /api/projects/[id]/instructions       system instructions + style card
```

Every one calls `getSession()` / `requireUser()` explicitly — `middleware.ts` is only an
edge presence check (`CLAUDE.md` § Auth & data). The media-proxy incident of 2026-07-15
is the precedent: do not assume a new route is covered.

### 7.3 `ConversationPanel` migration

Today the panel renders `threadItems` (generations) as the thread. After this change the
thread is `chat_messages`, and a generation attaches to the message that produced it via
`generationId`. The existing project-scoped pool and its "don't filter the shared feed"
rule carry over unchanged — that constraint (`CLAUDE.md` § Library feed) is why the panel
works for old projects at all, and a chat rewrite must not quietly reintroduce shared-pool
filtering.

### 7.4 Environment

```bash
LLM_BACKEND=comfy            # comfy | openai | mock   ← mock must work with nothing running
COMFY_LLM_URL=https://comfy-llm.internal
COMFY_LLM_TOKEN=…
COMFY_WORKFLOW_DIR=comfy/workflows
LLM_CHAT_MODEL=qwen3-vl-8b-instruct-4bit
LLM_UTILITY_MODEL=qwen3-4b-instruct
LLM_EMBED_MODEL=bge-m3
LLM_EMBED_DIM=1024
LLM_MAX_CONCURRENT=2         # the LLM instance's queue is 1-deep; this is the app-side gate
```

`mock` is not a nicety: without it, no one can develop the chat UI while the workstation
is off, exactly as `MOCK_GENERATION=1` exists for the generation path.

---

## 8. Build order

| Stage | Deliverable | Proves |
|---|---|---|
| 0 | `comfy-llm` instance + model server + tunnel + W9 | the whole transport works before any product code |
| 1 | `comfyui-veevee-nodes`: Request, LLMChat, StreamSink, Output, Telemetry | streaming reaches a browser |
| 2 | W1 + chat schema + SSE route + panel rewrite | two-way chat exists |
| 3 | W6, W7 | threads are navigable and survive length |
| 4 | W2 + `VeeveeFetchImage` | chat about images |
| 5 | W4, W5 + pgvector | per-project knowledge |
| 6 | W3 + `VeeveeJsonGuard` + provider profiles | the feature that pays for itself |
| 7 | W8 | asset descriptions, then role-detect A/B |

Stage 0 first is the point. Every hard problem here (tunnel auth, websocket relay,
cancellation, queue isolation) is in the transport, not in the prompts.

---

## 9. Evaluation

Reuse the frozen benchmark defined in `docs/llm-prompt-generation-research.md`
§"Evaluate downstream images, not eloquence" — 100–200 tasks, blind scoring on tag/role
binding and downstream image quality. Additions specific to this stack:

- **Streaming health:** p50/p95 TTFT, inter-token gap, dropped-frame rate (via `seq`).
- **Schema validity:** W3 must exceed 80% first-pass valid (the research doc's Phase 1
  exit gate), measured before the repair retry, not after.
- **Tag preservation:** 100% required. Any drop is a release blocker, not a score.
- **Queue behaviour:** 5 concurrent chats on a 1-deep queue — measure the wait, then
  decide whether `LLM_MAX_CONCURRENT` or a second instance is the fix.

---

## 10. Backlog — workflows not yet specified

Append here as they are proposed; promote to §6 with a full entry when they are built.

| ID | Name | Purpose | Status |
|---|---|---|---|
| B1 | `knowledge-rerank` | cross-encoder rerank of top-30 → top-6 | proposed; only if plain top-k measurably underperforms |
| B2 | `role-detect-local` | replace the paid Gemini role classifier with W8's VLM | proposed; gated on agreement measurement |
| B3 | `video-shotlist` | chat → structured shot list feeding `video-directive.ts` | proposed |
| B4 | `graph-rag-index` | entity/relation graph over a project bible (`comfyui_LLM_party` GraphRAG) | research |
| B5 | `prompt-critique` | explain the diff between the assistant's draft and the human's edit — the supervision signal for the shared LoRA | proposed; high value for Phase 4 data |
| B6 | `moderation-precheck` | flag prompts that will trip BytePlus's photoreal-face filter before spending | proposed |
| B7 | `local-image-generation` | SDXL/Flux graphs on `comfy-media` as a zero-cost draft tier | research; would change §3.1 |
| B8 | `semantic-asset-search` | CLIP-embed generated images for "find the shot like this" library search | research |

---

## 11. Change log

| Date | Change |
|---|---|
| 2026-07-29 | Document created. W1–W9 specified; conventions §4, shared components §5, backlog B1–B8. |
