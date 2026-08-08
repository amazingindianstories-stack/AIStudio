import test from "node:test";
import assert from "node:assert/strict";
import { callLLM, callGeminiRaw, agentModel } from "./llm-provider";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("agentModel defaults to gemini-flash-latest, overridable via AGENT_LLM_MODEL", () => {
  withEnv({ AGENT_LLM_MODEL: undefined }, () => {
    assert.equal(agentModel(), "gemini-flash-latest");
  });
  withEnv({ AGENT_LLM_MODEL: "gemini-pro-latest" }, () => {
    assert.equal(agentModel(), "gemini-pro-latest");
  });
});

test("callLLM throws when GOOGLE_API_KEY is unset, without making a network call", async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = (async () => {
    called = true;
    throw new Error("should not be called");
  }) as typeof fetch;
  try {
    await withEnv({ GOOGLE_API_KEY: undefined }, () =>
      assert.rejects(
        () => callLLM({ systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] }),
        /GOOGLE_API_KEY is not set/
      )
    );
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callLLM maps assistant->model, drops system messages, sends systemInstruction, and parses the text reply + usage", async () => {
  const originalFetch = global.fetch;
  let sentBody: any;
  let sentUrl = "";
  global.fetch = (async (url: string, init?: any) => {
    sentUrl = url;
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Try a wider shot." }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5 },
      }),
    };
  }) as unknown as typeof fetch;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      callLLM({
        systemPrompt: "You are helpful.",
        messages: [
          { role: "system", content: "ignored" },
          { role: "user", content: "help with framing" },
          { role: "assistant", content: "sure" },
        ],
      })
    );
    assert.equal(result.text, "Try a wider shot.");
    assert.deepEqual(result.usage, { tokensIn: 12, tokensOut: 5 });
    assert.match(sentUrl, /models\/gemini-flash-latest:generateContent$/);
    assert.equal(sentBody.systemInstruction.parts[0].text, "You are helpful.");
    assert.deepEqual(sentBody.contents, [
      { role: "user", parts: [{ text: "help with framing" }] },
      { role: "model", parts: [{ text: "sure" }] },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callLLM throws a descriptive error on a non-ok response", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: false,
    status: 429,
    text: async () => "RESOURCE_EXHAUSTED",
  })) as unknown as typeof fetch;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      assert.rejects(
        () => callLLM({ systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] }),
        /Agent LLM error \(429\)/
      )
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("callLLM throws when the response has no text candidate", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: "SAFETY" }] }),
  })) as unknown as typeof fetch;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      assert.rejects(
        () => callLLM({ systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] }),
        /Agent LLM returned no text \(SAFETY\)/
      )
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("callGeminiRaw omits `tools` from the request body when none are given", async () => {
  const originalFetch = global.fetch;
  let sentBody: any;
  global.fetch = (async (_url: string, init?: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) };
  }) as unknown as typeof fetch;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      callGeminiRaw({ systemPrompt: "sys", contents: [{ role: "user", parts: [{ text: "hi" }] }] })
    );
    assert.equal("tools" in sentBody, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callGeminiRaw sends declared tools as functionDeclarations and returns a functionCall part", async () => {
  const originalFetch = global.fetch;
  let sentBody: any;
  global.fetch = (async (_url: string, init?: any) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ functionCall: { name: "do_thing", args: { x: 1 } } }] } },
        ],
      }),
    };
  }) as unknown as typeof fetch;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      callGeminiRaw({
        systemPrompt: "sys",
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ name: "do_thing", description: "does a thing", parameters: { type: "object" } }],
      })
    );
    assert.deepEqual(sentBody.tools, [
      { functionDeclarations: [{ name: "do_thing", description: "does a thing", parameters: { type: "object" } }] },
    ]);
    assert.deepEqual(result.parts, [{ functionCall: { name: "do_thing", args: { x: 1 } } }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("callGeminiRaw returns an empty parts array (not a throw) when the candidate has no content", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: "SAFETY" }] }),
  })) as unknown as typeof fetch;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      callGeminiRaw({ systemPrompt: "sys", contents: [{ role: "user", parts: [{ text: "hi" }] }] })
    );
    assert.deepEqual(result.parts, []);
    assert.equal(result.finishReason, "SAFETY");
  } finally {
    global.fetch = originalFetch;
  }
});
