import test from "node:test";
import assert from "node:assert/strict";
import { createChatAgent } from "./base";

test("createChatAgent folds context into the system prompt and returns a normalized AgentResponse", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "test-key";
  let sentSystem = "";
  global.fetch = (async (_url, init) => {
    sentSystem = JSON.parse(init.body).systemInstruction.parts[0].text;
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    };
  }) ;
  try {
    const agent = createChatAgent("video");
    const response = await agent.run({
      role: "video",
      messages: [{ role: "user", content: "add a slow push in" }],
      context: { currentPrompt: "a car driving", model: "Seedance 2.0", aspectRatio: "16:9" },
    });
    assert.deepEqual(response.messages, [{ role: "assistant", content: "ok" }]);
    assert.equal(response.usage, undefined);
    assert.match(sentSystem, /Current context:/);
    assert.match(sentSystem, /- currentPrompt: a car driving/);
    assert.match(sentSystem, /- model: Seedance 2\.0/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalKey;
  }
});

test("createChatAgent omits the context block entirely when no context is given", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GOOGLE_API_KEY;
  process.env.GOOGLE_API_KEY = "test-key";
  let sentSystem = "";
  global.fetch = (async (_url, init) => {
    sentSystem = JSON.parse(init.body).systemInstruction.parts[0].text;
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    };
  }) ;
  try {
    const agent = createChatAgent("story");
    await agent.run({ role: "story", messages: [{ role: "user", content: "beat sheet?" }] });
    assert.doesNotMatch(sentSystem, /Current context:/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalKey;
  }
});
