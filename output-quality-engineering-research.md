# Engineering levers for output quality & accuracy — research findings

**Question:** is there anything we as software engineers can do to improve our website's output quality and accuracy, so we can reliably deliver what users ask for?

**Short answer:** yes, and the codebase already does more of this than a typical team at this stage — but there are four concrete gaps, all fixable with normal engineering work (no model training, no new vendor), and one of them is almost certainly the reason "Higgsfield/Dreamina look better than us" keeps recurring for video specifically.

---

## 1. What's already built (so we don't re-recommend it)

Worth stating plainly, because most of the industry-standard levers below are *already implemented* for the image path:

- **Structured prompt assembly** (`shot-spec.js`, `prompt-assembler.js`) — role-labeled reference legends, framing codas, in-prompt negative blocks. This is the same "Subject/Composition/Action/Location/Style" template Google's own prompting guide recommends, done automatically instead of relying on the user to hand-write it.
- **Identity tiling** (`image-prep.js`) — face crops sent as extra images, functionally the same goal as IP-Adapter/PuLID reference conditioning (more visual bandwidth on the identity-critical region), adapted to work through a hosted API rather than local diffusion weights.
- **LLM-as-judge, multi-axis, with a floor** (`face-judge.js`) — `judgeCandidate` scores identity/prominence/sharpness in one call and `selectBestCandidate` picks the best composite *without letting identity regress* (a hard floor, not just a weighted average). This matches current best practice almost exactly: rubric-based, multi-criteria scoring beats a single coarse score, and industry research this year measured LMM-judge-to-human correlation as high as 0.96 when done this way.
- **Best-of-N as the primary quality lever** (`FACE_BEST_OF`), chosen *because it was measured* to beat single-pass prompt tricks — this is literally the "you are spending generation calls on a reward function" pattern the automatic-prompt-optimization literature describes, just applied at the candidate-selection layer instead of the prompt-search layer.
- **A real research methodology already in house** — `.council/higgsfield-nbp-parity/` is a genuine, evidence-based investigation (pulled 800 real jobs from Higgsfield's own MCP history, dumped raw payloads, diffed stored vs. typed prompts) that reached the same conclusions the industry research below reaches independently. This isn't a green-field recommendation list; it's confirming the team already knows how to do this.

The gaps below are about *where this rigor stops*, not about missing fundamentals.

---

## 2. Gap 1 — the rigor stops at the image path; video never got it

This is the direct answer to the Higgsfield/Dreamina complaint from earlier in this conversation. `video-directive.js`'s own header says its scaffolding is **"reasoned, not bake-off measured"** — unlike `shot-spec.js`, which has an actual A/B result (2.4× subject prominence, no identity loss) behind it. Nobody has done the video equivalent of the `research-higgsfield.md` investigation: pull real Seedance job history from Higgsfield's MCP, diff stored vs. typed prompts, check reference resolution handling, check whether batching/curation differs.

**Why this matters more than it sounds:** industry practice this year has converged on treating "the prompt" as something you *search and measure*, not something you write once and trust — "the paradigm shift in 2026 is not a new prompt trick, it's treating the prompt as something you search rather than something you write, with an eval as the objective" (Future AGI, 2026). Right now that discipline exists for images and not for video, in a codebase that otherwise clearly believes in it.

**Concrete next step:** the exact same read-only, zero-cost MCP probe technique used for NBP, pointed at Seedance/video jobs instead. Already discussed above in this conversation — this is the highest-leverage single action available, because it's cheap and it directly resolves a recurring artist complaint instead of a hypothetical one.

---

## 3. Gap 2 — no evaluation harness; regressions are caught by hand, one script at a time

`scripts/ab-face-eval.js` and the various `probe-*.js` scripts are real, but they're **one-off, manually-run comparisons**, not a standing regression suite. There's no dataset of "known prompts + expected quality bar" that every change to `shot-spec.js`, `video-directive.js`, `kling-input.js`, or the judge prompts gets run against automatically.

Industry framing (Arize AI, DeepEval, 2026): *"The harness exposes evaluation as a first-class step in the build pipeline — candidate prompt and model changes run through a regression dataset, scored by the same evaluators used in production, and failures block the merge. This is the single most effective pattern for preventing silent quality regressions."* Also directly relevant: *"implementing context relevance, answer faithfulness, and tool selection accuracy catches 70% of pre-launch failures with minimal setup overhead"* — the equivalent here would be identity/prominence/sharpness scores (already computed by `judgeCandidate`!) run against a fixed set of representative prompts+references, on every change to the prompt-assembly code.

**Why this is low-effort here specifically:** the scoring function already exists (`judgeCandidate`). The missing piece isn't a new capability, it's wiring: a small fixed corpus of real (anonymized) reference images + prompts, a script that runs the current `assemblePrompt`/`video-directive` output through generation once, scores it, and diffs the score against a committed baseline. That's a much smaller lift than it sounds, because 90% of the machinery (the judge, the scoring axes, the selection logic) is already written and tested.

**Concrete next step:** turn `ab-face-eval.js` from a manual comparison script into a `npm run eval:regression` script that runs against a small committed fixture set and fails loudly (or at least prints a clear delta) if a change moves the scores backward. Gate it in CI the same way the existing unit test suites are gated.

---

## 4. Gap 3 — no reproducibility / seed control anywhere

None of the five providers in this app (`gemini.js`, `kling.js`, `seedance.js`, `omni.js`, `higgsfield-mcp.js`) expose or store a `seed` parameter. Every generation is stochastic with no way to reproduce a specific result, re-run a fix with everything else held constant, or hand an artist "generate this exact composition again but fix the hand."

Industry framing (Morphic AI glossary; getmaxim.ai, 2026): *"Recording the seed alongside the prompt, model, and settings constitutes the minimum viable version control for AI generation work."* This is a small, mechanical gap relative to the others — most of the underlying provider APIs already accept a seed parameter (BytePlus's Seedance endpoint, for instance, lists `seed integer, default -1` directly in its docs), it's just not threaded through this app's request builders or persisted on the `generations` row.

**Concrete next step:** thread `seed` through the provider payloads where each API supports it, store it on the generation row (same pattern as `videoTaskMode`/`generateAudio` — persisted at enqueue time so it survives the enqueue→execute split), and surface a "regenerate with same seed" action in the UI. This directly helps the exact workflow that's presumably causing artist frustration: iterating toward a specific look without the whole composition re-rolling each time.

---

## 5. Gap 4 — no signal from real usage, only a bookmark flag

The `generations` table has `isFavorite`, which is a bookmark, not a quality signal — there's no "this didn't match what I asked for" or any lightweight rating captured anywhere in the schema or API routes. That means the team's only quality signal is anecdotal (artists mentioning it in conversation, like right now), not measurable.

Industry framing, with an important caveat attached (Future AGI / Axiom, 2026): thumbs-style feedback is real signal *if* connected to the underlying generation (prompt, provider, scores, references) so a downvote becomes a concrete regression-test case — but also, *"less than 1% of users in most production deployments ever click thumbs buttons... never train directly on thumbs data, it's noisy and skews negative."* So this isn't "add a 5-star rating and trust the average" — it's "add a lightweight signal, and use it to build the Gap 2 regression corpus out of real failures instead of synthetic ones."

**Concrete next step:** a low-friction "flag this" action on a generated item (separate from delete/favorite), captured with enough context (prompt, model, references, judge scores if available) to become a regression-test fixture. This is the cheapest of the four gaps to close and directly feeds Gap 2.

---

## 6. What I'd deliberately *not* chase right now

For completeness, since the research surfaced these as live industry directions and it's worth saying explicitly why they're lower priority here:

- **Search-based automatic prompt optimization** (textual-gradient/evolutionary prompt search against a reward model — ProTeGi/OPRO/GEPA-style). This is the genuine 2026 frontier, but it's the opposite of this codebase's stated position: `shot-spec.js`'s header explicitly rejects LLM-rewritten prompts after the "movie camera" incident (meta-instructions got rendered literally). A search-based optimizer is a bigger, riskier bet than the four gaps above, and none of the four require revisiting that decision. Worth revisiting only after Gap 2 (a real eval harness) exists to safely evaluate it against.
- **Retrieval-augmented prompt construction** (pulling from a curated prompt/style library) — this is essentially what Higgsfield's "Shots" preset feature turned out to be (Higgsfield-authored template text, injected on explicit user selection, confirmed in the MCP research — not automatic retrieval). It's a legitimate feature idea (a curated preset library for this app) but it's a product decision, not a quality-engineering fix, and shouldn't be conflated with "why does the same prompt look different elsewhere."
- **Local diffusion techniques (IP-Adapter, LoRA, ControlNet)** — not applicable as-is; every provider here is a hosted API, not a locally-run diffusion pipeline this app controls the weights of. `pyserver/`'s local InstantID path is the one place this *is* relevant and already uses adapter-style identity conditioning; it's a separate, optional local path, not the main pipeline.

---

## 7. Priority order

1. **Gap 1** (video parity investigation) — cheapest, zero-cost, directly answers a live complaint.
2. **Gap 3** (seed threading) — small, mechanical, immediately useful to artists iterating on a look.
3. **Gap 2** (regression harness) — more setup, but the highest long-term leverage: everything else (including validating whatever Gap 1 finds) gets safer once this exists.
4. **Gap 4** (feedback capture) — cheap to ship, but only pays off once Gap 2 exists to consume it.

---

## Sources

- [Automatic Prompt Optimization: 2026 Techniques Guide](https://futureagi.com/blog/automatic-prompt-optimization/)
- [Preference-Guided Prompt Optimization for Text-to-Image Generation](https://arxiv.org/html/2602.13131v1)
- [LLM-as-a-Judge in 2026: Top evaluation techniques and best practices — DeepEval](https://deepeval.com/blog/llm-as-a-judge)
- [A survey on LLM-as-a-judge — ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2666675825004564)
- [IP-Adapter: visual reference conditioning for AI — Morphic](https://morphic.com/ai-glossary/IP-Adapter)
- [ComfyUI Consistent Characters: IP-Adapter, PuLID and LoRA Guide](https://www.media.io/image-tips/comfyui-consistent-characters.html)
- [What is an evaluation harness? — Arize AI](https://arize.com/blog/what-is-an-evaluation-harness/)
- [Eval harness: what it is, how to use it, and why you should care — DeepEval](https://deepeval.com/blog/what-is-an-eval-harness)
- [Building an Evaluation Harness for Production AI Agents — Towards Data Science](https://towardsdatascience.com/building-an-evaluation-harness-for-production-ai-agents-a-12-metric-framework-from-100-deployments/)
- [Seed in AI generation: reproduce and control your results — Morphic](https://morphic.com/ai-glossary/Seed)
- [Version Control for Prompts: The Foundation of Reliable AI Workflows](https://www.getmaxim.ai/articles/version-control-for-prompts-the-foundation-of-reliable-ai-workflows/)
- [User Feedback Loops in 2026: Closing the AI Data Improvement Cycle](https://futureagi.com/blog/integrating-user-feedback-automated-data-layers/)
- [Close the loop: User feedback for AI capabilities — Axiom](https://axiom.co/blog/user-feedback)
- [AI Video Generator Prompt Adherence: 2026 Strategy Guide](https://resource.digen.ai/ai-video-generator-prompt-adherence-guide-2026/)
- BytePlus ModelArk — Create a video generation task (live docs, checked 2026-08-17): `seed integer, default -1`, `https://console.byteplus.com/ark/region:ap-southeast-1/docs/ModelArk/1520757`
