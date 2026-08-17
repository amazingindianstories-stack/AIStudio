import test from "node:test";
import assert from "node:assert/strict";
import { assemblePrompt } from "./prompt-assembler";
import { roleHeader } from "./shot-spec";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function withShotSpec(fn) {
  const keys = [
    "PROMPT_SHOT_SPEC",
    "PROMPT_ROLE_DETECT",
    "FACE_CROP_MIDDLEWARE",
    "GOOGLE_API_KEY",
  ] ;
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
    const asset = {
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

// ── mixed untagged batches (2026-08-17 style-drift fix) ─────────────────────
//
// These run outside withShotSpec's env (which disables FACE_CROP_MIDDLEWARE
// for every other test in this file) because the bug being fixed only shows
// up when per-image identity detection is actually active.

const STYLE_IMG =
  "data:image/png;base64,ZmFrZS1zdHlsZS1ib2FyZC1pbWFnZS1kYXRh";

async function withMixedBatchDetection(fn) {
  const keys = [
    "PROMPT_SHOT_SPEC",
    "PROMPT_ROLE_DETECT",
    "FACE_CROP_MIDDLEWARE",
    "GOOGLE_API_KEY",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PROMPT_SHOT_SPEC = "1";
  process.env.PROMPT_ROLE_DETECT = "0";
  delete process.env.FACE_CROP_MIDDLEWARE; // leave identity detection ON
  process.env.GOOGLE_API_KEY = "test-key";
  const previousFetch = globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function mockClassifierFetch(faceDataB64) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    const parts = body.contents[0].parts;
    const promptText = parts.find((p) => typeof p.text === "string")?.text ?? "";
    const inlineData = parts.find((p) => p.inlineData)?.inlineData;
    const isFaceImage = inlineData?.data === faceDataB64;

    if (promptText.includes("helping build a face-identity pipeline")) {
      const json = isFaceImage
        ? { person_reference: true, face_box_2d: [100, 100, 900, 900], panel_boxes: null }
        : { person_reference: false, face_box_2d: null, panel_boxes: null };
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (promptText.includes("Classify the PRIMARY subject")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"role":"style"}' }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error("unexpected fetch in test: " + promptText.slice(0, 80));
  };
}

test("mixed untagged batch: face + style board split into separate groups, not folded into one SUBJECT", async () => {
  await withMixedBatchDetection(async () => {
    globalThis.fetch = mockClassifierFetch(PNG.split(",")[1]);

    const assembled = await assemblePrompt(
      "He walks home through the city at dusk.",
      [],
      [PNG, STYLE_IMG],
      { aspectRatio: "16:9" }
    );

    assert.equal(assembled.groups.length, 2, "face and style board land in separate groups");
    const subject = assembled.groups.find((g) => g.tag === "SUBJECT");
    const styleGroup = assembled.groups.find((g) => g.tag !== "SUBJECT");

    assert.ok(subject, "face image kept its own SUBJECT group");
    assert.equal(subject.images.length, 1);
    assert.equal(subject.identity, true);

    assert.ok(styleGroup, "style board split into its own non-person group");
    assert.equal(styleGroup.images.length, 1);
    assert.equal(styleGroup.identity, false);
    assert.match(styleGroup.header, /STYLE reference/i);
    assert.match(
      assembled.shotInstruction ?? "",
      /exact visual style\/grade to match/i
    );
  });
});

test("mixed untagged batch: all-person images stay on the single legacy SUBJECT path", async () => {
  await withMixedBatchDetection(async () => {
    // Both images read as faces — nothing confidently non-person, so this
    // must behave exactly like before: one merged SUBJECT group.
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      person_reference: true,
                      face_box_2d: [100, 100, 900, 900],
                      panel_boxes: null,
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );

    const assembled = await assemblePrompt(
      "Two angles of the same person, cinematic lighting.",
      [],
      [PNG, STYLE_IMG],
      { aspectRatio: "16:9" }
    );

    assert.equal(assembled.groups.length, 1);
    assert.equal(assembled.groups[0].tag, "SUBJECT");
    assert.equal(assembled.groups[0].images.length, 2);
  });
});
