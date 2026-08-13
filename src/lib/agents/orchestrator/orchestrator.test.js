import test from "node:test";
import assert from "node:assert/strict";
import { runOrchestratorTurn } from "./orchestrator";

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** Returns a fetch stub that hands out `responses` in order (by call count)
 *  and records every parsed request body for inspection. */
function mockFetchSequence(responses) {
  const bodies = [];
  let call = 0;
  const fn = (async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const response = responses[Math.min(call, responses.length - 1)];
    call++;
    return { ok: true, json: async () => response };
  }) ;
  return { fn, bodies, callCount: () => call };
}

test("no tool call: returns the model's text directly, no toolTrace, tools declared in the request", async () => {
  const originalFetch = global.fetch;
  const { fn, bodies } = mockFetchSequence([
    { candidates: [{ content: { parts: [{ text: "Sure, ask away." }] } }] },
  ]);
  global.fetch = fn;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      runOrchestratorTurn(
        [
          { role: "system", content: "ignored" },
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
        "Hi — what can you help me with?"
      )
    );
    assert.equal(result.reply, "Sure, ask away.");
    assert.equal(result.toolTrace, undefined);
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].contents, [
      { role: "user", parts: [{ text: "earlier question" }] },
      { role: "model", parts: [{ text: "earlier answer" }] },
      { role: "user", parts: [{ text: "Hi — what can you help me with?" }] },
    ]);
    assert.equal(bodies[0].tools[0].functionDeclarations[0].name, "design_prompt");
  } finally {
    global.fetch = originalFetch;
  }
});

test("design_prompt tool call: dispatches to the subagent and continues to a final reply", async () => {
  const originalFetch = global.fetch;
  const { fn, bodies } = mockFetchSequence([
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "design_prompt", args: { idea: "a detective" } } }],
          },
        },
      ],
    },
    { candidates: [{ content: { parts: [{ text: "A moody portrait of a detective." }] } }] },
    { candidates: [{ content: { parts: [{ text: "Here's your prompt!" }] } }] },
  ]);
  global.fetch = fn;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      runOrchestratorTurn([], "design me a detective portrait prompt")
    );
    assert.equal(result.reply, "Here's your prompt!");
    assert.deepEqual(result.toolTrace, {
      tool: "design_prompt",
      args: { idea: "a detective" },
      result: { prompt: "A moody portrait of a detective." },
    });
    assert.equal(bodies.length, 3);
    // third call (orchestrator continuation) carries the functionResponse back
    const lastContents = bodies[2].contents;
    const last = lastContents[lastContents.length - 1];
    assert.deepEqual(last, {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "design_prompt",
            response: { prompt: "A moody portrait of a detective." },
          },
        },
      ],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("a functionCall's thoughtSignature is echoed back verbatim on the next round (Gemini 400s without it)", async () => {
  const originalFetch = global.fetch;
  const { fn, bodies } = mockFetchSequence([
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "design_prompt", args: { idea: "a detective" } },
                thoughtSignature: "opaque-signature-abc123",
              },
            ],
          },
        },
      ],
    },
    { candidates: [{ content: { parts: [{ text: "A moody portrait." }] } }] },
    { candidates: [{ content: { parts: [{ text: "Here's your prompt!" }] } }] },
  ]);
  global.fetch = fn;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      runOrchestratorTurn([], "design me a detective portrait prompt")
    );
    // second call (subagent) and third (continuation) both carry the growing
    // `contents` array, which includes the model's functionCall turn pushed
    // after round 1 — assert it kept the sibling thoughtSignature field.
    const modelTurn = bodies[2].contents.find((c) => c.role === "model");
    assert.equal(modelTurn.parts[0].thoughtSignature, "opaque-signature-abc123");
    assert.deepEqual(modelTurn.parts[0].functionCall, {
      name: "design_prompt",
      args: { idea: "a detective" },
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("an unknown tool name is fed back as an error functionResponse rather than throwing", async () => {
  const originalFetch = global.fetch;
  const { fn, bodies } = mockFetchSequence([
    {
      candidates: [
        { content: { parts: [{ functionCall: { name: "nonexistent_tool", args: {} } }] } },
      ],
    },
    { candidates: [{ content: { parts: [{ text: "Sorry, I can't do that." }] } }] },
  ]);
  global.fetch = fn;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      runOrchestratorTurn([], "call a tool that doesn't exist")
    );
    assert.equal(result.reply, "Sorry, I can't do that.");
    assert.equal(bodies.length, 2);
    const lastContents = bodies[1].contents;
    const last = lastContents[lastContents.length - 1];
    assert.match(last.parts[0].functionResponse.response.error, /Unknown tool: nonexistent_tool/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("kind='video' declares generate_video (not generate_image) and mentions video in the system prompt", async () => {
  const originalFetch = global.fetch;
  const { fn, bodies } = mockFetchSequence([
    { candidates: [{ content: { parts: [{ text: "Sure." }] } }] },
  ]);
  global.fetch = fn;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      runOrchestratorTurn([], "hi", [], "video")
    );
    const names = bodies[0].tools[0].functionDeclarations.map((t) => t.name);
    assert.deepEqual(names, ["design_prompt", "generate_video"]);
    assert.match(bodies[0].systemInstruction.parts[0].text, /generate_video/);
    assert.doesNotMatch(bodies[0].systemInstruction.parts[0].text, /generate_image/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("kind='image' (default): a generate_image tool call surfaces via toolTrace for the client to act on", async () => {
  const originalFetch = global.fetch;
  const { fn } = mockFetchSequence([
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "generate_image", args: { prompt: "a red bicycle" } } }],
          },
        },
      ],
    },
    { candidates: [{ content: { parts: [{ text: "Generating that now!" }] } }] },
  ]);
  global.fetch = fn;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      runOrchestratorTurn([], "generate that")
    );
    assert.equal(result.reply, "Generating that now!");
    assert.deepEqual(result.toolTrace, {
      tool: "generate_image",
      args: { prompt: "a red bicycle" },
      result: { prompt: "a red bicycle" },
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("exceeding the tool-call round limit throws rather than looping forever", async () => {
  const originalFetch = global.fetch;
  // Always returns a functionCall with no text — the model "never finishes".
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({
      candidates: [
        { content: { parts: [{ functionCall: { name: "design_prompt", args: { idea: "x" } } } ] } },
      ],
    }),
  })) ;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      assert.rejects(
        () => runOrchestratorTurn([], "loop forever"),
        /exceeded the tool-call round limit/
      )
    );
  } finally {
    global.fetch = originalFetch;
  }
});
