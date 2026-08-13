import test from "node:test";
import assert from "node:assert/strict";
import { dispatchTool, toolsForKind } from "./tools";

test("toolsForKind('image') declares design_prompt and generate_image", () => {
  const tools = toolsForKind("image");
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, "design_prompt");
  assert.deepEqual(tools[0].parameters.required, ["idea"]);
  assert.equal(tools[1].name, "generate_image");
  assert.deepEqual(tools[1].parameters.required, ["prompt"]);
});

test("toolsForKind('video') declares design_prompt and generate_video, not generate_image", () => {
  const tools = toolsForKind("video");
  assert.equal(tools.length, 2);
  assert.equal(tools[1].name, "generate_video");
  assert.ok(!tools.some((t) => t.name === "generate_image"));
});

test("dispatchTool throws on an unknown tool name", async () => {
  await assert.rejects(() => dispatchTool("not_a_real_tool", {}, []), /Unknown tool: not_a_real_tool/);
});

test("dispatchTool: design_prompt defaults idea to empty string and references to undefined when missing", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "test-key";
  let sentText = "";
  global.fetch = (async (_url, init) => {
    sentText = JSON.parse(init.body).contents[0].parts[0].text;
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "a prompt" }] } }] }) };
  }) ;
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

test("dispatchTool: generate_image echoes the prompt back with no network call", async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = (async () => {
    called = true;
    throw new Error("should not be called");
  }) ;
  try {
    const result = await dispatchTool("generate_image", { prompt: "a red bicycle" }, []);
    assert.deepEqual(result.response, { ok: true, prompt: "a red bicycle" });
    assert.deepEqual(result.trace, {
      tool: "generate_image",
      args: { prompt: "a red bicycle" },
      result: { prompt: "a red bicycle" },
    });
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("dispatchTool: generate_video throws on an empty prompt", async () => {
  await assert.rejects(
    () => dispatchTool("generate_video", { prompt: "   " }, []),
    /generate_video called with an empty prompt/
  );
});
