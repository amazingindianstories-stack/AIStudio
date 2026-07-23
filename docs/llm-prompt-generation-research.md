# Multimodal Prompt Assistant: Cost and Implementation Study

Date: 2026-07-16

## Executive decision

Build a provider-neutral prompt-assistant feature and run an A/B evaluation before
fine-tuning anything.

Recommended first release:

1. Use `gpt-5.4-mini` as the hosted quality baseline.
2. Run `Qwen3-VL-8B-Instruct` and `Qwen3-VL-30B-A3B-Instruct` locally on the
   existing 64 GB M1 Ultra Mac Studio as open-model challengers.
3. Keep ComfyUI optional for visual workflow orchestration. Serve the VLM through
   MLX-VLM, llama.cpp, or vLLM behind an OpenAI-compatible HTTP interface.
4. Do not train a separate model for every project. Store each project's style as
   structured context and retrieve approved examples. Consider one shared LoRA
   only after enough accepted and edited examples have been collected.

The OpenAI API is unlikely to be the major cost in this workflow. At the measured
median output length, a typical `gpt-5.4-mini` request with one high-detail image is
about **$0.0054 / INR 0.52**. The image or video generation that follows will
normally cost much more.

## What was measured in this repository

The generation ledger was queried on 2026-07-16 using aggregate-only SQL. No
prompt text, reference image, user data, or credential was printed.

| Measure | Result |
|---|---:|
| Generation records | 354 |
| Successful Nano Banana Pro image generations | 342 |
| Records with at least one stored reference | 189 (53.4%) |
| Median prompt length | 2,872 characters |
| 75th percentile prompt length | 4,666 characters |
| 90th percentile prompt length | 6,559 characters |
| 95th percentile prompt length | 7,449 characters |
| Maximum prompt length | 21,927 characters |
| Median stored reference count | 1 |
| 90th percentile reference count | 2 |
| Maximum reference count | 6 |

These are final generation prompts, not complete ChatGPT conversations. Token
counts below therefore use a transparent planning estimate of four characters per
text token and add system instructions, the user's short brief, and visual tokens.
Actual billing must be captured from API `usage` fields after the pilot.

## OpenAI cost sheet

### Current prices used

Standard API prices per one million tokens:

| Model | Input | Cached input | Output | Intended role here |
|---|---:|---:|---:|---|
| `gpt-5.4-nano` | $0.20 | $0.02 | $1.25 | Cheapest challenger; quality risk |
| `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 | Recommended baseline |
| `gpt-5.4` | $2.50 | $0.25 | $15.00 | Escalation for difficult cases |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[GPT-5.4 mini model card](https://developers.openai.com/api/docs/models/gpt-5.4-mini),
and [GPT-5.4 model card](https://developers.openai.com/api/docs/models/gpt-5.4).

OpenAI meters image inputs as tokens. GPT-5.4 mini and nano cover images with
32 x 32 pixel patches; high detail is capped at 1,536 patches and then multiplied
by 1.62 for mini or 2.46 for nano. GPT-5.4 high detail allows up to 2,500 patches.
Explicitly use `detail: "high"`, not `auto`, and resize references before upload so
cost and latency remain bounded. See the official
[vision token calculation](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs).

### Per-request estimates

The table assumes a prompt-only response, no web search or other paid tools. INR
uses the [RBI page's 2026-07-15 indicative value](https://m.rbi.org.in/Scripts/NotificationUser.aspx?Id=2126&Mode=0)
of **INR 96.2219 / USD** and is only for budgeting.

| Workload | Planning token assumption | 5.4 nano | 5.4 mini | 5.4 |
|---|---|---:|---:|---:|
| Quick, no reference | 900 text in, 450 out | $0.00074 / INR 0.07 | $0.00270 / INR 0.26 | $0.0090 / INR 0.87 |
| Typical | 1,200 text in, one 1024-square-equivalent image, 720 out | $0.00164 / INR 0.16 | **$0.00538 / INR 0.52** | $0.01636 / INR 1.57 |
| Measured P90 output | 1,500 text in, two max-budget high-detail images, 1,640 out | $0.00386 / INR 0.37 | $0.01224 / INR 1.18 | $0.04085 / INR 3.93 |
| Heavy revision | 2,000 text in, four max-budget high-detail images, 2,500 out | $0.00655 / INR 0.63 | $0.02021 / INR 1.95 | $0.06750 / INR 6.50 |

Formula:

```text
request_cost = (text_input_tokens + billed_image_tokens) * input_rate
             + output_tokens * output_rate
```

Reasoning tokens, when generated, are billed as output tokens. Production should
set a response token ceiling and use low or no reasoning for routine drafting.

### Monthly typical-workload estimates

| Requests/month | 5.4 nano | 5.4 mini | 5.4 |
|---:|---:|---:|---:|
| 1,000 | $1.64 / INR 158 | **$5.38 / INR 518** | $16.36 / INR 1,574 |
| 10,000 | $16.44 / INR 1,582 | **$53.84 / INR 5,181** | $163.60 / INR 15,743 |
| 100,000 | $164.38 / INR 15,818 | **$538.42 / INR 51,812** | $1,636 / INR 157,421 |

Prompt caching can reduce repeated system/project context input cost by 90% on the
listed models, but it does not reduce output cost. Put stable instructions first,
keep them byte-identical, and append variable user content and images afterward.
Batch pricing is 50% lower but is unsuitable for an interactive chat response.

## Open-source and ComfyUI comparison

### Important architecture correction

ComfyUI is a node-based workflow and inference orchestrator. It can run custom
nodes and accept workflows in API mode, but it is not the preferred production
server or training framework for a multimodal LLM. This distinction is explicit
in the [ComfyUI workflow documentation](https://docs.comfy.org/development/core-concepts/workflow)
and [custom-node API overview](https://docs.comfy.org/custom-nodes/overview).

Recommended separation:

```text
Next.js UI
  -> /api/prompt-assistant (provider-neutral contract)
      -> OpenAI Responses API
      -> local/cloud OpenAI-compatible VLM endpoint
          -> MLX-VLM on Apple Silicon, or vLLM/llama.cpp on NVIDIA
      -> optional ComfyUI workflow after the prompt is approved
```

This prevents the chat feature from inheriting ComfyUI queueing, custom-node
security, and workflow-versioning concerns. ComfyUI can still compose the approved
prompt with later image/video nodes.

### Candidate models

| Candidate | Why test it | Suggested hardware | Decision |
|---|---|---|---|
| Qwen3-VL-8B-Instruct | Fast, multimodal, multi-image, easy local baseline | Existing Mac or 16-24 GB NVIDIA | Test first |
| Qwen3-VL-30B-A3B-Instruct | Better quality ceiling; only about 3B active MoE parameters per token | Existing 64 GB Mac at 4-bit, or 48 GB NVIDIA | Primary open challenger |
| Qwen3-VL-32B-Instruct | Dense quality option but heavier than A3B | 48 GB+ NVIDIA preferred | Test only if A3B quality disappoints |
| Qwen3-VL-2B/4B | Low latency and edge deployment | Mac or small GPU | Triage/classification, not final prompt writer |

Qwen3-VL has official 2B, 4B, 8B, 30B-A3B, and 32B releases, supports multi-image
inputs and controllable visual-token budgets, and recommends vLLM for serving.
The 30B-A3B model is Apache 2.0 licensed. Sources:
[Qwen3-VL repository](https://github.com/QwenLM/Qwen3-VL) and
[30B-A3B model card](https://huggingface.co/Qwen/Qwen3-VL-30B-A3B-Instruct).

MLX-VLM provides vision-language inference, fine-tuning, a FastAPI server, and
Apple Silicon support; llama.cpp also exposes multimodal models through an
OpenAI-compatible chat endpoint. Sources:
[MLX-VLM](https://github.com/Blaizzy/mlx-vlm) and
[llama.cpp multimodal documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md).

### Infrastructure cost

The current Mac Studio makes a local pilot effectively zero-rental-cost. It is not
a production SLA: it needs uptime, secure networking, monitoring, concurrency
limits, and a fallback provider.

Representative Runpod pod prices on 2026-07-16 are L4 $0.39/hour, A40 $0.44/hour,
RTX A6000 $0.49/hour, and L40S $0.99/hour. Prices exclude persistent storage,
egress, engineering time, and idle/cold-start overhead. Source:
[Runpod GPU pricing](https://www.runpod.io/pricing).

| GPU schedule | L4 | A40 | A6000 | L40S |
|---|---:|---:|---:|---:|
| 60 hours/month | $23.40 | $26.40 | $29.40 | $59.40 |
| 8 hours/day (240 h) | $93.60 | $105.60 | $117.60 | $237.60 |
| Always on (730 h) | $284.70 | $321.20 | $357.70 | $722.70 |

At the typical 5.4-mini estimate, an always-on A40 breaks even on raw provider
spend at roughly **59,700 requests/month**. An A6000 breaks even near 66,400.
This ignores staff time and assumes the open model matches quality. Scheduled
60-hour A40 compute crosses the same raw-cost line near 4,900 requests/month, but
only if requests can be concentrated into those hours and the model stays loaded.

### Cost conclusion

| Factor | OpenAI 5.4 mini | Existing Mac + Qwen | Cloud GPU + Qwen |
|---|---|---|---|
| Initial cash cost | Very low | No GPU rental | Low to moderate |
| Cost at low volume | Best operationally | Best cash-only | Worst if idle |
| Cost at high steady volume | Linear | Electricity + operations | Can win with high utilization |
| Quality baseline | Strong | Must be measured | Must be measured |
| Privacy/control | External processor | Highest | Depends on host |
| Reliability/concurrency | Managed | Limited by one workstation | Configurable |
| Maintenance | Low | High | Medium-high |

The rational sequence is hosted baseline -> local comparison -> fine-tune only if
the measured quality/cost/privacy trade-off warrants it.

## How to reach high-quality prompt output

### 1. Define one structured output contract

Do not ask the model for an uncontrolled essay. Require JSON such as:

```json
{
  "intent_summary": "string",
  "reference_roles": [
    { "tag": "@img1", "role": "person", "must_preserve": ["identity"] }
  ],
  "prompt": "final generation prompt",
  "negative_constraints": ["unwanted condition"],
  "assumptions": ["assumption needing review"],
  "warnings": ["reference conflict or missing input"]
}
```

Validate this server-side. Render only the useful fields in the chat. The final
prompt must preserve `@imgN` and saved-asset tags because this codebase already
uses them as the binding contract in `prompt-assembler.ts`.

### 2. Give the model project memory, not unlimited chat history

Create a versioned project style card:

- medium and target provider
- visual genre and realism level
- camera/lens/framing preferences
- lighting and color rules
- period, geography, and cultural constraints
- recurring characters, locations, wardrobe, and immutable attributes
- prohibited motifs and known model failure modes
- three to ten approved prompt examples

Retrieve only relevant assets and examples for each turn. Summarize old chat turns
instead of repeatedly sending every image. Store reference analyses so unchanged
images do not need to be reprocessed on every revision.

### 3. Use a two-pass pipeline

Pass A is visual grounding: identify each image's role and extract observable,
non-speculative attributes. Pass B writes the target-model prompt using the user's
brief, the grounded reference facts, the project style card, and provider rules.

For OpenAI this may still be one API call with a structured internal instruction.
For the open stack it can be two calls so the intermediate grounding is cacheable
and testable. Never let the writer invent identity, wardrobe, or location facts
that contradict the reference pass.

### 4. Make provider profiles explicit

Nano Banana, Seedance, Omni, and future generators do not need identical prompt
syntax. Maintain versioned prompt profiles in code with:

- supported reference count and roles
- recommended prompt length
- tag syntax
- camera/motion vocabulary
- negative-prompt behavior
- hard limits and known failure cases

The assistant selects a profile; the VLM should not be expected to remember
current provider quirks from its base weights.

### 5. Evaluate downstream images, not eloquence

Build a frozen benchmark of 100-200 tasks, with at least:

- no-reference ideation
- one character
- character plus wardrobe
- character plus location
- multiple characters
- location-only and object-only references
- ambiguous/mismatched tags
- revisions that must preserve earlier constraints
- wide, vertical, close-up, and full-body framing
- image and video prompt variants

Blind-score each candidate on instruction coverage, correct tag/role binding,
identity/wardrobe/location preservation, composition, hallucination rate, edit
distance from an expert prompt, latency, and actual cost. Generate downstream
images for a smaller stratified subset and use both human review and the existing
face/composite judge. A prompt that reads well but generates worse images loses.

## Fine-tuning strategy

### Do not fine-tune yet

The current ledger contains final prompts and references, but not the complete
supervision pair: original user request -> assistant draft -> human edit -> accepted
prompt -> quality outcome. Training on prompt text alone teaches imitation, not
reliable transformation or reference binding.

Start logging these fields for every assistant turn:

```text
project_style_version, provider_profile_version, user_brief,
reference_ids_and_roles, assistant_model_and_version, assistant_draft,
human_edited_prompt, accepted/rejected, generated_media_id,
favorite/rating, latency_ms, input_tokens, output_tokens, cost
```

### When to use retrieval, a shared LoRA, or a project adapter

| Situation | Correct mechanism |
|---|---|
| Project names, current assets, changing style rules | Retrieval/style card |
| A few approved examples for one project | Few-shot examples |
| Stable prompt-writing behavior across all projects | One shared LoRA/SFT adapter |
| A large project with genuinely distinct stable grammar and 500-1,000+ approved pairs | Optional project adapter |
| New facts or new characters | Retrieval, never weight training |

Per-project training is usually the wrong boundary. It fragments data, increases
adapter routing/versioning work, and becomes stale when art direction changes.
Name the product whatever the brand requires, but preserve the underlying model
and license attribution in technical/legal records. Do not imply that renamed
weights were trained from scratch.

### Shared LoRA plan

1. Collect at least 500 clean accepted/edit pairs; 1,500-5,000 is preferable.
2. Hold out entire projects, not random rows, to test generalization.
3. Deduplicate near-identical prompt variants and remove secrets/PII.
4. Balance reference counts, roles, image/video targets, aspect ratios, and genres.
5. Start from Qwen3-VL-8B-Instruct with the vision encoder frozen.
6. Train only the LLM adapter using LoRA/QLoRA for three epochs; compare checkpoints.
7. Promote to 30B-A3B only if the 8B adapter cannot meet the quality gate.
8. Re-run the frozen benchmark and a downstream generation subset.
9. Version the base model, adapter, dataset manifest, prompt profile, and eval report.
10. Keep the hosted baseline as fallback and for periodic teacher-data creation.

Qwen's official training framework supports multi-image conversation data, LoRA
rank/alpha configuration, selective tuning of the vision, projector, and language
components, and warns that training resolution is performance-critical. Its 32B
example requires eight 80 GB GPUs, which is another reason not to begin with full
32B training. Source: [Qwen VL fine-tuning framework](https://github.com/QwenLM/Qwen3-VL/tree/main/qwen-vl-finetune).

Compute rental for a small LoRA experiment is usually minor relative to dataset
curation and evaluation. Reserve a planning range of 4-12 GPU-hours for an 8B
adapter experiment and 8-24 suitable GPU-hours for a quantized 30B experiment,
then replace those ranges with measured throughput from a 100-example smoke run.
These are planning estimates, not vendor guarantees.

## Detailed delivery plan

### Phase 0: Instrumentation and benchmark (3-5 engineering days)

1. Export a privacy-reviewed set of 100-200 representative tasks.
2. Add the structured output schema and target-provider profiles.
3. Define scoring rubrics and an evaluator UI or CSV workflow.
4. Add assistant usage/cost fields and edit/acceptance events to the database.
5. Establish quality, P95 latency, and maximum cost gates before comparing models.

Exit gate: benchmark and telemetry work without generating media automatically.

### Phase 1: OpenAI baseline (3-5 engineering days)

1. Add `PromptAssistantProvider` with a streaming `generate()` contract.
2. Implement the OpenAI Responses API using `gpt-5.4-mini`, high-detail images,
   structured output, an output token cap, and explicit low reasoning.
3. Put stable policy/profile text first to benefit from prompt caching.
4. Add per-user/project quotas, timeouts, cancellation, retries, and redacted logs.
5. Show the draft in the existing composer with Apply, Revise, and Compare actions.
6. Never auto-trigger a paid image/video generation from an assistant response.

Exit gate: at least 80% schema-valid responses and a measured cost distribution.

### Phase 2: Local open-model benchmark (4-7 engineering days)

1. Install MLX-VLM in an isolated service on the M1 Ultra.
2. Test quantized Qwen3-VL 8B and 30B-A3B with identical structured instructions.
3. Cap visual tokens consistently and measure warm/cold latency and memory.
4. Expose a protected OpenAI-compatible endpoint on the private network.
5. Add it as a second provider; keep the client and output schema unchanged.
6. Run blind A/B evaluation against OpenAI on the frozen set.

Exit gate: select the smallest open model within five quality points of the hosted
baseline, with acceptable P95 latency and zero schema regressions.

### Phase 3: Product pilot (1-2 weeks of real use)

1. Default routine requests to the winning low-cost provider.
2. Add a quality-escalation route to `gpt-5.4-mini` or `gpt-5.4`.
3. Collect prompt edits, acceptance, ratings, generation outcomes, and costs.
4. Review failure clusters weekly and fix profiles/retrieval before fine-tuning.
5. Recalculate break-even using actual requests, latency, and operator time.

Exit gate: stable acceptance rate and enough clean training pairs to make an SFT
experiment meaningful.

### Phase 4: Shared adapter experiment (only after the data gate)

1. Create a reproducible, versioned multimodal SFT dataset.
2. Train an 8B LoRA with frozen vision components.
3. Compare base Qwen, tuned Qwen, and OpenAI on held-out projects.
4. Reject the adapter if it improves style imitation but harms role binding or
   downstream generation quality.
5. Deploy with canary traffic, rollback, and base-model fallback.

## Security and operational requirements

- Do not expose a local MLX, llama.cpp, vLLM, or ComfyUI port directly to the web.
- Authenticate service-to-service calls and restrict accepted image MIME/size/count.
- Strip EXIF metadata unless it is explicitly needed.
- Keep reference URLs short-lived or fetch media server-side from trusted storage.
- Set provider, user, and project budgets independently.
- Store model/version/profile hashes with every draft for reproducibility.
- Review OpenAI data controls and retention requirements before sending production
  character/location assets.
- Treat community ComfyUI nodes as executable third-party code; pin and audit them.

## Final recommendation

Use OpenAI to establish the quality target, not as an assumed permanent dependency.
At current measured prompt sizes, `gpt-5.4-mini` costs about half a rupee for a
typical request, so it is cheaper to learn with the managed baseline than to begin
with model training. In parallel, exploit the existing M1 Ultra to benchmark
Qwen3-VL locally at nearly zero rental cost.

Choose the open model only after it matches the baseline on reference-role binding
and downstream generated media. Use project style cards and retrieved examples for
project-specific behavior. Train one shared LoRA later, from accepted/edit data,
instead of maintaining a separate model for each project.
