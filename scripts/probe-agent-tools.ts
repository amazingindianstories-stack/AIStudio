/**
 * Probe the orchestrator's tool-calling round trip
 * (src/lib/agents/orchestrator/orchestrator.ts).
 *
 * Gemini's function-calling REST contract — specifically whether the
 * functionResponse turn goes back as role "user" (what orchestrator.ts
 * assumes, per Google's REST examples) rather than a separate "function"
 * role some SDKs use — isn't something to trust from memory. This runs the
 * real production code path (runOrchestratorTurn) end to end.
 *
 * Makes TWO real generateContent calls minimum (one plain chat turn, one that
 * should trigger design_prompt — which is itself a second call, so three
 * total) on a Flash-tier model. Negligible cost, but real. Never run this
 * from an automated path.
 *
 *   npx tsx scripts/probe-agent-tools.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { runOrchestratorTurn } from "../src/lib/agents/orchestrator/orchestrator";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function main() {
  console.log("── plain chat turn (should NOT call a tool) ──────────────────\n");
  const plain = await runOrchestratorTurn([], "Hi — what can you help me with here?");
  check("got a non-empty reply", plain.reply.trim().length > 0);
  check("no tool was called", plain.toolTrace === undefined, plain.toolTrace ? `(called ${plain.toolTrace.tool})` : "");
  console.log(`  reply: ${plain.reply.slice(0, 200).replace(/\n/g, " ")}\n`);

  console.log("── design_prompt turn (should call the tool) ──────────────────\n");
  const designed = await runOrchestratorTurn(
    [],
    "I want a moody portrait of a detective in a rain-soaked neon alley, film noir style. Design me a prompt for that."
  );
  check("design_prompt tool fired", designed.toolTrace?.tool === "design_prompt", JSON.stringify(designed.toolTrace));
  check("got a non-empty final reply", designed.reply.trim().length > 0);
  if (designed.toolTrace) {
    const result = designed.toolTrace.result as { prompt?: string } | undefined;
    check("subagent produced a prompt string", typeof result?.prompt === "string" && result.prompt.length > 0);
    check("subagent's prompt avoids @tag syntax", !/@\w+/.test(result?.prompt ?? ""));
    console.log(`  designed prompt: ${(result?.prompt ?? "").slice(0, 300).replace(/\n/g, " ")}`);
  }
  console.log(`  final reply: ${designed.reply.slice(0, 200).replace(/\n/g, " ")}\n`);

  console.log(failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
