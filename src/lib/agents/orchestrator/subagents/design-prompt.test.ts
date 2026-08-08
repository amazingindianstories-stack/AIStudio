import test from "node:test";
import assert from "node:assert/strict";
import { designPrompt } from "./design-prompt";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
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

test("designPrompt sends the idea, references, and attached images, and trims the returned prompt", async () => {
  const originalFetch = global.fetch;
  let sentBody: any;
  global.fetch = (async (_url: string, init?: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "  A moody portrait.  " }] } }] }) };
  }) as unknown as typeof fetch;
  try {
    const result = await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      designPrompt({
        idea: "a detective in a rainy alley",
        references: "match this character's face",
        images: [{ inlineData: { mimeType: "image/jpeg", data: "QUJD" } }],
      })
    );
    assert.equal(result.prompt, "A moody portrait.");
    const userParts = sentBody.contents[0].parts;
    assert.match(userParts[0].text, /a detective in a rainy alley/);
    assert.match(userParts[0].text, /match this character's face/);
    assert.match(userParts[0].text, /1 reference image\(s\) are attached/);
    assert.deepEqual(userParts[1], { inlineData: { mimeType: "image/jpeg", data: "QUJD" } });
  } finally {
    global.fetch = originalFetch;
  }
});

test("designPrompt notes when no images are attached", async () => {
  const originalFetch = global.fetch;
  let sentBody: any;
  global.fetch = (async (_url: string, init?: any) => {
    sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "A prompt." }] } }] }) };
  }) as unknown as typeof fetch;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      designPrompt({ idea: "a simple idea", images: [] })
    );
    assert.match(sentBody.contents[0].parts[0].text, /No reference images are attached/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("designPrompt throws when the model returns no text", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({ candidates: [{ finishReason: "SAFETY" }] }),
  })) as unknown as typeof fetch;
  try {
    await withEnv({ GOOGLE_API_KEY: "test-key" }, () =>
      assert.rejects(
        () => designPrompt({ idea: "x", images: [] }),
        /design_prompt subagent returned no text \(SAFETY\)/
      )
    );
  } finally {
    global.fetch = originalFetch;
  }
});
