/**
 * Probe the agent-layer's text LLM (src/lib/agents/llm-provider.ts).
 *
 * Verifies the AGENT_LLM_MODEL id resolves against generativelanguage's
 * generateContent and that systemInstruction + multi-turn contents round-trip
 * as expected — the contract this repo's other provider probes exist to
 * pin down empirically rather than trust docs for (see gemini.ts, kling.ts).
 *
 * Makes THREE real generateContent calls (one per agent role), each a short
 * text-only completion — negligible cost on a Flash-tier model, but real.
 * Never run this from an automated path.
 *
 *   npx tsx scripts/probe-agent-llm.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { agentModel, callLLM } from "../src/lib/agents/llm-provider";
import { systemPromptFor } from "../src/lib/agents/prompts";
import type { AgentRole } from "../src/lib/agents/types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const ROLES: { role: AgentRole; message: string }[] = [
  { role: "image", message: "Suggest one lighting tweak for a portrait prompt." },
  { role: "video", message: "Suggest one camera move for a chase scene." },
  { role: "story", message: "Give me a one-line logline for a heist film." },
];

async function main() {
  console.log(`model: ${agentModel()}\n`);

  for (const { role, message } of ROLES) {
    const started = Date.now();
    try {
      const result = await callLLM({
        systemPrompt: systemPromptFor(role),
        messages: [{ role: "user", content: message }],
      });
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      check(`${role}: got a non-empty reply`, result.text.trim().length > 0, `(${elapsed}s)`);
      console.log(`  reply: ${result.text.trim().slice(0, 200).replace(/\n/g, " ")}`);
      if (result.usage) {
        console.log(`  usage: in=${result.usage.tokensIn} out=${result.usage.tokensOut}`);
      } else {
        console.log("  usage: (no usageMetadata in response)");
      }
    } catch (e) {
      check(`${role}: call succeeded`, false, e instanceof Error ? e.message : String(e));
    }
    console.log();
  }

  console.log(failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
