# Agent layer overview

This documents the LLM chat-assistant layer added on `feature/agent-layer`, and how it maps
the original "AIStudio" project guide's vision onto Lumina Studio's actual architecture.

## Where the guide and the real app disagree

The guide that motivated this work assumes a project shape this repo doesn't have:

| Guide assumption | Actual Lumina Studio |
|---|---|
| Three separate screens (Image / Video / Storyboard) | One page, one composer with a `mode: "image" \| "video"` toggle (`src/lib/store.ts`) |
| A "Storyboard" screen (script/beat-sheet tool) | The Canvas Board (`src/components/canvas/`) — a spatial whiteboard, not a script editor |
| `src/server/agents`, `src/server/llm/provider.ts` | No `src/server/` in this repo — everything server-side lives in `src/lib/*` and `src/app/api/*` |
| Generic LLM provider abstraction (OpenRouter or Gemini) | `GOOGLE_API_KEY` already reaches `generativelanguage.googleapis.com` for images (`gemini.ts`) and video (`omni.ts`) via direct `fetch` — no SDK anywhere in this codebase |

This implementation keeps the guide's core idea (per-pane chat assistants backed by a small
`Agent` abstraction) but places it inside the repo's actual conventions rather than the guide's
assumed file layout, and maps "story" onto the Canvas Board rather than inventing a fourth
screen.

## What shipped

- **`src/lib/agents/`** — the agent abstraction, adapted from the guide:
  - `types.ts` — `AgentRequest` / `AgentResponse` / `Agent` (role stays `"image" | "video" | "story"`).
  - `llm-provider.ts` — `callLLM()`, a direct-`fetch` wrapper around Gemini's `generateContent`,
    reusing `GOOGLE_API_KEY`. Model id is `AGENT_LLM_MODEL` (default: Google's `gemini-flash-latest`
    alias). Verify the contract with `npx tsx scripts/probe-agent-llm.ts`.
  - `prompts.ts` — one system prompt per role, grounded in this app's real vocabulary: the
    `@img1`/`@slug` tag system, the actual model roster (Nano Banana Pro, Kling, Seedance, Omni
    Flash), and the Canvas Board for the story role.
  - `imageAgent.ts` / `videoAgent.ts` / `storyAgent.ts` / `base.ts` / `registry.ts` — thin
    per-role `Agent` implementations sharing one `createChatAgent()` factory.
- **Routes**: `POST /api/agents/{image,video,story}` (`src/app/api/agents/*/route.ts`), each a
  five-line wrapper around `src/lib/agents/route-handler.ts`'s `handleAgentRequest()`, which
  does auth (`getSession()`, matching every other route), manual body validation (no `zod` — this
  codebase doesn't use one), calls the agent, and normalizes the response.
- **Frontend**: `src/components/AgentChat.tsx`, a small non-streaming chat panel. Wired in as:
  - An "Ask Assistant" chip in `PromptComposer.tsx`'s toolbar, role bound to the composer's
    current `mode`, with context = current prompt draft, model, and aspect ratio.
  - A toolbar button in `CanvasToolbar.tsx` (Canvas Board), role `"story"`, context = the active
    board's name.

## Explicitly out of scope (v1)

- Streaming responses (`// TODO: streaming` markers mark the swap point in `AgentChat.tsx` and
  the guide's own "optionally add streaming" ask).
- Tool-calling — agents invoking image/video generation directly (the guide's "later" item).
  `imageAgent.ts` / `videoAgent.ts` / `storyAgent.ts` each carry a TODO marking where that would
  attach.
- Sending the Canvas Board's full node/connector graph as story-agent context — only the board
  name is sent today.
- Any spend/budget gating on chat calls — `spend-window.ts` stays scoped to billed image/video
  generations per its own header comment; text chat is far cheaper and ungated.

## Testing

`src/lib/agents/*.test.ts` (`node:test`, no new test framework) covers prompt selection, context
folding, response normalization, and request validation, with `global.fetch` mocked — no network
calls or cost in the test suite. Run: `npx tsx --test src/lib/agents/*.test.ts`.
