import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKlingInput } from "./kling-input";

/**
 * Pins the adaptation from the multi-image assembled payload to Kling's
 * single-image endpoint. Pure — no network, no spend.
 *
 * The cases that motivated it all came from real generations on 2026-07-31:
 * an @slug asset that never reached the provider, prompts arriving with literal
 * "@img1"/"@img2"/"@img1-inspired" in them, and shotInstruction being built and
 * then ignored.
 */

const img = (data = "AAAA") => ({ mimeType: "image/png", data });

function group(over = {}) {
  return { tag: "@img1", header: "@img1 — REFERENCE:", images: [img()], ...over };
}

function assembled(over = {}) {
  return { instruction: "a red bicycle", groups: [], ...over };
}

const MODEL = "Kling Image 3.0";

// ── reference selection ─────────────────────────────────────────────────────

test("text-to-image passes the prompt through with no reference", () => {
  const out = buildKlingInput(assembled(), MODEL);
  assert.equal(out.reference, undefined);
  assert.equal(out.prompt, "a red bicycle");
});

test("a saved @slug asset reaches Kling", () => {
  // The bug this module exists for: the route counted raw uploads, so an asset
  // referenced by @slug resolved into a group and then went nowhere.
  const out = buildKlingInput(
    assembled({
      instruction: "a cinematic board of @shiv",
      groups: [group({ tag: "@shiv", images: [img("SHIV")], identity: true })],
    }),
    MODEL
  );
  assert.equal(out.reference?.data, "SHIV");
});

test("groups with no images do not count as references", () => {
  const out = buildKlingInput(
    assembled({ groups: [group({ images: [] }), group({ images: [img("REAL")] })] }),
    MODEL
  );
  assert.equal(out.reference?.data, "REAL");
});

test("identity tiles are never sent in place of the reference", () => {
  // Tiles are a Gemini bandwidth trick; spending Kling's one slot on a face crop
  // rather than the user's actual reference would be a downgrade.
  const out = buildKlingInput(
    assembled({
      groups: [group({ images: [img("FULL")], tiles: [img("CROP")], identity: true })],
    }),
    MODEL
  );
  assert.equal(out.reference?.data, "FULL");
});

// ── the one-reference limit ─────────────────────────────────────────────────

test("two groups are rejected, not silently trimmed", () => {
  assert.throws(
    () =>
      buildKlingInput(
        assembled({ groups: [group({ tag: "@priya" }), group({ tag: "@img1" })] }),
        MODEL
      ),
    /resolved to 2/
  );
});

test("two images inside ONE group are rejected too", () => {
  // Untagged uploads collapse into a single SUBJECT group holding several
  // angles. Counting groups rather than images would have let 4 through.
  assert.throws(
    () => buildKlingInput(assembled({ groups: [group({ images: [img(), img()] })] }), MODEL),
    /resolved to 2/
  );
});

test("the multi-reference error names the tags and a way forward", () => {
  try {
    buildKlingInput(
      assembled({ groups: [group({ tag: "@priya" }), group({ tag: "@img1" })] }),
      MODEL
    );
    assert.fail("expected a throw");
  } catch (e) {
    const msg = (e ).message;
    assert.match(msg, /@priya, @img1/);
    assert.match(msg, /Nano Banana Pro/);
    assert.match(msg, /Kling Image 3\.0/); // the model the user actually picked
  }
});

// ── tag rewriting ───────────────────────────────────────────────────────────

test("the resolved tag becomes plain language, not machine syntax", () => {
  const out = buildKlingInput(
    assembled({ instruction: "@priya on a beach", groups: [group({ tag: "@priya" })] }),
    MODEL
  );
  assert.match(out.prompt, /the reference image on a beach/);
  assert.equal(out.prompt.includes("@priya"), false);
});

test("every occurrence of the tag is rewritten", () => {
  const out = buildKlingInput(
    assembled({
      instruction: "@img1 sitting, then @img1 standing, then @IMG1 again",
      groups: [group()],
    }),
    MODEL
  );
  assert.equal(/@img1/i.test(out.prompt), false);
});

test("a tag used as a compound word keeps the rest of the word", () => {
  // Observed in a real prompt: "@img1-inspired". Rewriting the tag first is what
  // stops the leftover-slug pass from turning it into a bare "img1-inspired".
  const out = buildKlingInput(
    assembled({ instruction: "an @img1-inspired palette", groups: [group()] }),
    MODEL
  );
  assert.match(out.prompt, /the reference image-inspired palette/);
});

test("an untagged prompt with a reference is left alone", () => {
  const out = buildKlingInput(
    assembled({ instruction: "a woman on a beach", groups: [group({ tag: "SUBJECT" })] }),
    MODEL
  );
  assert.match(out.prompt, /a woman on a beach/);
});

test("a dangling @imgN resolves to the one reference in play", () => {
  // With a single image attached there is nothing else @img2 could mean.
  const out = buildKlingInput(
    assembled({ instruction: "@img1 and @img2 for lighting", groups: [group()] }),
    MODEL
  );
  assert.equal(/@img\d/.test(out.prompt), false);
  assert.match(out.prompt, /for lighting/);
});

test("a tagged prompt with NO reference attached is a loud error", () => {
  assert.throws(
    () => buildKlingInput(assembled({ instruction: "use @img1 for lighting" }), MODEL),
    /tags @img1 but no reference image is attached/
  );
});

test("an unresolved @slug loses the app syntax but keeps the word", () => {
  // It named no image, so there is nothing to bind — but it is still the user's
  // word, usually a name, and inventing a referent would be worse.
  const out = buildKlingInput(assembled({ instruction: "a board of @shiv" }), MODEL);
  assert.equal(out.prompt, "a board of shiv");
});

test("a mid-word @ is treated as a tag, matching the rest of the app", () => {
  // Documenting a real limitation rather than asserting around it: TAG_REGEX
  // does not require the @ to start a token, so "a@b.com" in prompt text loses
  // its @ and renders as "ab.com". This module deliberately matches
  // parseAssetSlugs, which already reads "@b" there as a slug — diverging would
  // be worse, because a tag that assemblePrompt resolved could then survive
  // un-rewritten. Fix it in mentions.ts if it ever bites, not here.
  const out = buildKlingInput(assembled({ instruction: "sign reading a@b.com" }), MODEL);
  assert.equal(out.prompt, "sign reading ab.com");
});

// ── the reference rule header ───────────────────────────────────────────────

test("a person reference gets the identity rule", () => {
  const out = buildKlingInput(
    assembled({ groups: [group({ identity: true })] }),
    MODEL
  );
  assert.match(out.prompt, /^REFERENCE IMAGE — reproduce this exact person/);
  assert.match(out.prompt, /never a lookalike/);
});

test("a non-person reference gets the subject rule, not the face wording", () => {
  const out = buildKlingInput(
    assembled({ groups: [group({ identity: false })] }),
    MODEL
  );
  assert.match(out.prompt, /^REFERENCE IMAGE — reproduce exactly what this shows/);
  assert.equal(/bone structure/.test(out.prompt), false);
});

test("text-to-image gets no reference header at all", () => {
  const out = buildKlingInput(assembled(), MODEL);
  assert.equal(out.prompt.includes("REFERENCE IMAGE"), false);
});

test("the header is suppressed when shot-spec supplies its own legend", () => {
  // PROMPT_SHOT_SPEC=1 is on in this deployment, so this is the live path.
  // shotInstruction opens with a role-aware REFERENCES legend; adding the
  // generic header too both duplicates the binding and contradicts it — with a
  // style reference the legend said "the exact visual style/grade to match"
  // while the header asserted "reproduce exactly what this shows".
  const out = buildKlingInput(
    assembled({
      shotInstruction: "REFERENCES:\n@img1 = the exact visual style to match.\n\nSCENE: a rooftop",
      groups: [group({ identity: false })],
    }),
    MODEL
  );
  assert.equal(out.prompt.includes("REFERENCE IMAGE —"), false);
  assert.match(out.prompt, /the exact visual style to match/);
  assert.match(out.prompt, /^REFERENCES:/);
});

test("the header stays short enough not to eat the 2500-char budget", () => {
  // Real prompts here already reach 3300 characters against a 2500 cap, so
  // scaffolding has to be cheap. The full KIND_RULE is ~700 chars; this is the
  // condensed one, and a regression to the verbose wording should fail here.
  const out = buildKlingInput(assembled({ instruction: "x", groups: [group({ identity: true })] }), MODEL);
  assert.ok(out.prompt.length < 450, `header is ${out.prompt.length} chars`);
});

// ── shot-spec precedence ────────────────────────────────────────────────────

test("shotInstruction wins over the raw prompt when present", () => {
  const out = buildKlingInput(
    assembled({ instruction: "raw", shotInstruction: "SCENE: structured" }),
    MODEL
  );
  assert.match(out.prompt, /SCENE: structured/);
  assert.equal(out.prompt.includes("raw"), false);
});

test("shotInstruction is used verbatim, never re-wrapped in another SCENE:", () => {
  const out = buildKlingInput(
    assembled({ instruction: "raw", shotInstruction: "SCENE: structured" }),
    MODEL
  );
  assert.equal(out.prompt.match(/SCENE:/g)?.length, 1);
});

test("tags inside shotInstruction are rewritten too", () => {
  const out = buildKlingInput(
    assembled({
      instruction: "raw",
      shotInstruction: "LEGEND: @priya\nSCENE: @priya on a beach",
      groups: [group({ tag: "@priya" })],
    }),
    MODEL
  );
  assert.equal(out.prompt.includes("@priya"), false);
});

// ── no shared-regex leakage ─────────────────────────────────────────────────

test("repeated calls give identical results", () => {
  // MENTION_REGEX/TAG_REGEX are module-level and /g. Using them directly would
  // leave lastIndex advanced and make the SECOND call behave differently — for
  // this module and for every other consumer in the process.
  const input = () =>
    assembled({ instruction: "@img1 and @img2 and @shiv", groups: [group()] });
  const first = buildKlingInput(input(), MODEL).prompt;
  for (let i = 0; i < 3; i++) {
    assert.equal(buildKlingInput(input(), MODEL).prompt, first, `call ${i + 2} differed`);
  }
});
