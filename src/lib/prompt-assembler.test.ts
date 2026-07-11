import test from "node:test";
import assert from "node:assert/strict";
import { assemblePrompt } from "./prompt-assembler";
import { roleHeader } from "./shot-spec";
import type { Asset } from "./types";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function withShotSpec<T>(fn: () => Promise<T>): Promise<T> {
  const keys = [
    "PROMPT_SHOT_SPEC",
    "PROMPT_ROLE_DETECT",
    "FACE_CROP_MIDDLEWARE",
    "GOOGLE_API_KEY",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PROMPT_SHOT_SPEC = "1";
  process.env.PROMPT_ROLE_DETECT = "0";
  // These tests exercise deterministic routing. Face crop behavior has its
  // own integration path; disabling it here also proves explicit person text
  // preserves identity even when no extra crop can be produced.
  process.env.FACE_CROP_MIDDLEWARE = "0";
  delete process.env.GOOGLE_API_KEY;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("single tagged school reference is LOCATION, never forced SUBJECT/FACE", async () => {
  await withShotSpec(async () => {
    const prompt =
      "Use @img1 as the exact location: an empty school hallway, camera looking down from the upper landing.";
    const assembled = await assemblePrompt(prompt, [], [PNG, PNG], {
      aspectRatio: "16:9",
    });

    assert.equal(assembled.instruction, prompt);
    assert.equal(assembled.groups.length, 1);
    assert.equal(assembled.groups[0].tag, "@img1");
    assert.equal(assembled.groups[0].images.length, 1, "only the tagged upload is sent");
    assert.equal(assembled.groups[0].identity, false);
    assert.equal(assembled.groups[0].tiles, undefined);
    assert.match(assembled.groups[0].header, /LOCATION reference/i);
    assert.doesNotMatch(
      assembled.groups[0].header,
      /FACE\/IDENTITY|exact person|same individual/i
    );
    assert.equal(assembled.judgeFace, undefined);
    assert.match(
      assembled.shotInstruction ?? "",
      /@img1 = the exact location\/setting/i
    );
    assert.doesNotMatch(
      assembled.shotInstruction ?? "",
      /plasticky skin|duplicated limbs|warped anatomy/i
    );
  });
});

test("single tagged face retains the legacy SUBJECT identity contract", async () => {
  await withShotSpec(async () => {
    const prompt =
      "THIS EXACT FACE and identity from @img1. She is looking down at a book.";
    const assembled = await assemblePrompt(prompt, [], [PNG], {
      aspectRatio: "16:9",
    });

    assert.equal(assembled.groups.length, 1);
    assert.equal(assembled.groups[0].tag, "SUBJECT");
    assert.equal(assembled.groups[0].identity, true);
    assert.equal(
      assembled.groups[0].header,
      roleHeader("SUBJECT", "person", 1)
    );
    assert.match(
      assembled.shotInstruction ?? "",
      /SUBJECT = the exact face\/identity/i
    );
    assert.match(assembled.shotInstruction ?? "", /hero composition/i);
  });
});

test("untagged person upload remains the byte-stable legacy SUBJECT path", async () => {
  await withShotSpec(async () => {
    const prompt = "A portrait of the subject looking down at a book.";
    const assembled = await assemblePrompt(prompt, [], [PNG], {
      aspectRatio: "16:9",
    });

    assert.equal(assembled.groups.length, 1);
    assert.equal(assembled.groups[0].tag, "SUBJECT");
    assert.equal(assembled.groups[0].identity, true);
    assert.equal(
      assembled.groups[0].header,
      roleHeader("SUBJECT", "person", 1)
    );
  });
});

test("named character asset keeps its person identity path unchanged", async () => {
  await withShotSpec(async () => {
    const asset: Asset = {
      id: "asset-priya",
      kind: "character",
      name: "Priya",
      slug: "priya",
      images: [PNG],
      createdAt: 1,
      updatedAt: 1,
    };
    const prompt = "@priya is looking down at a book.";
    const assembled = await assemblePrompt(prompt, [asset], [], {
      aspectRatio: "16:9",
    });

    assert.equal(assembled.groups.length, 1);
    assert.equal(assembled.groups[0].tag, "@priya");
    assert.equal(assembled.groups[0].identity, true);
    assert.equal(
      assembled.groups[0].header,
      roleHeader("@priya", "person", 1)
    );
    assert.match(assembled.shotInstruction ?? "", /hero composition/i);
  });
});

test("ambiguous singleton fails safe to the legacy person path when role detection is unavailable", async () => {
  await withShotSpec(async () => {
    const assembled = await assemblePrompt("Make @img1 cinematic.", [], [PNG], {
      aspectRatio: "16:9",
    });

    assert.equal(assembled.groups[0].tag, "SUBJECT");
    assert.equal(assembled.groups[0].identity, true);
    assert.equal(
      assembled.groups[0].header,
      roleHeader("SUBJECT", "person", 1)
    );
  });
});

test("visual person detection overrides a nearby school keyword for singleton face safety", async () => {
  await withShotSpec(async () => {
    const previousFetch = globalThis.fetch;
    process.env.GOOGLE_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"role":"person"}' }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    try {
      const assembled = await assemblePrompt(
        "@img1 looking down in a school hallway.",
        [],
        [PNG],
        { aspectRatio: "16:9" }
      );

      assert.equal(assembled.groups[0].tag, "SUBJECT");
      assert.equal(assembled.groups[0].identity, true);
      assert.equal(
        assembled.groups[0].header,
        roleHeader("SUBJECT", "person", 1)
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("confident singleton location detection removes identity when prompt role is ambiguous", async () => {
  await withShotSpec(async () => {
    const previousFetch = globalThis.fetch;
    process.env.GOOGLE_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"role":"location"}' }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    try {
      const assembled = await assemblePrompt(
        "Use @img1 exactly, looking down from above.",
        [],
        [PNG],
        { aspectRatio: "16:9" }
      );

      assert.equal(assembled.groups[0].tag, "@img1");
      assert.equal(assembled.groups[0].identity, false);
      assert.match(assembled.groups[0].header, /LOCATION reference/i);
      assert.equal(assembled.judgeFace, undefined);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("confident untagged location detection opts out of the legacy person path", async () => {
  await withShotSpec(async () => {
    const previousFetch = globalThis.fetch;
    process.env.GOOGLE_API_KEY = "test-key";
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"role":"location"}' }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    try {
      const assembled = await assemblePrompt(
        "An empty school hallway, looking down from above.",
        [],
        [PNG],
        { aspectRatio: "16:9" }
      );

      assert.equal(assembled.groups[0].tag, "REFERENCE");
      assert.equal(assembled.groups[0].identity, false);
      assert.match(assembled.groups[0].header, /LOCATION reference/i);
      assert.equal(assembled.judgeFace, undefined);
      assert.doesNotMatch(
        assembled.shotInstruction ?? "",
        /plasticky skin|duplicated limbs|warped anatomy/i
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("untagged classifier uncertainty preserves the legacy identity fallback", async () => {
  await withShotSpec(async () => {
    const assembled = await assemblePrompt(
      "A cinematic scene at sunset.",
      [],
      [PNG],
      { aspectRatio: "16:9" }
    );

    assert.equal(assembled.groups[0].tag, "SUBJECT");
    assert.equal(assembled.groups[0].identity, true);
  });
});
