import test from "node:test";
import assert from "node:assert/strict";
import { dispatchTool, TOOLS } from "./tools";

test("TOOLS declares design_prompt with idea required and references optional", () => {
  assert.equal(TOOLS.length, 1);
  assert.equal(TOOLS[0].name, "design_prompt");
  assert.deepEqual(TOOLS[0].parameters.required, ["idea"]);
});

test("dispatchTool throws on an unknown tool name", async () => {
  await assert.rejects(() => dispatchTool("not_a_real_tool", {}, []), /Unknown tool: not_a_real_tool/);
});

test("dispatchTool: design_prompt defaults idea to empty string and references to undefined when missing", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "test-key";
  let sentText = "";
  global.fetch = (async (_url: string, init?: any) => {
    sentText = JSON.parse(init.body).contents[0].parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "a prompt" }] } }] }) };
  }) as unknown as typeof fetch;
  try {
    const result = await dispatchTool("design_prompt", {}, []);
    assert.equal(result.response.prompt, "a prompt");
    assert.equal(result.trace.tool, "design_prompt");
    assert.doesNotMatch(sentText, /Reference usage:/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalKey;
  }
});
