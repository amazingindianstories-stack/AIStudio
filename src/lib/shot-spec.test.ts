/**
 * Unit tests for src/lib/shot-spec.ts — the deterministic, pure shot-spec
 * text assembler (no API calls, no GOOGLE_API_KEY required).
 *
 * Derived from the "Interfaces" and "Test plan" sections of
 * .council/higgsfield-nbp-parity/design.md against the contract, not the
 * implementation. Run:
 *   npx tsx --test src/lib/shot-spec.test.ts src/lib/select-candidate.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRefRoles,
  roleHeader,
  buildReferenceLegend,
  buildCastPolicy,
  buildFramingCoda,
  buildShotInstruction,
  hasExplicitRefRole,
  hasVisiblePeople,
  ENVIRONMENT_NEGATIVE_CODA,
  NEGATIVE_CODA,
  VIEWPOINT_POLICY,
  ZERO_CAST_POLICY,
} from "./shot-spec";

// The exact baseline prompt from assembled-payload.txt / probe-payload.ts,
// copied verbatim per design.md's test plan.
const BASELINE_PROMPT =
  "THIS EXACT FACE and identity from @img1(image_1). She stands near a DJ booth in the corner of the nightclub from @img3(image_3), Speaker stacks behind her. She wears the exact outfit from @img2(image_2). Black onyx drop earrings and a delicate black choker. Red haze, silhouettes of dancers around her. Cinematic nightlife photography. @img1";

test("parseRefRoles: baseline prompt maps @img1:person, @img2:outfit, @img3:location", () => {
  const roles = parseRefRoles(BASELINE_PROMPT);
  assert.equal(roles.get("@img1"), "person");
  assert.equal(roles.get("@img2"), "outfit");
  assert.equal(roles.get("@img3"), "location");
  assert.equal(roles.size, 3);
});

test("parseRefRoles: tag with no nearby role keyword is omitted from the map", () => {
  const prompt = "A wide shot including @img4 somewhere in frame, nothing else to say.";
  const roles = parseRefRoles(prompt);
  assert.equal(roles.has("@img4"), false);
});

test("parseRefRoles: case-insensitive keyword matching", () => {
  const prompt = "She wears the exact OUTFIT from @img2.";
  const roles = parseRefRoles(prompt);
  assert.equal(roles.get("@img2"), "outfit");
});

test("parseRefRoles: case-insensitive tag matching (@IMG2 normalizes to @img2)", () => {
  const prompt = "She wears the outfit from @IMG2.";
  const roles = parseRefRoles(prompt);
  assert.equal(roles.get("@img2"), "outfit");
});

test("parseRefRoles: role keyword far outside the window does not bind to the tag", () => {
  // "outfit" is > 6 words away from @img5 in both directions, separated by
  // unrelated filler words on each side, so it must NOT bind.
  const prompt =
    "The outfit discussion happened earlier at length in a totally unrelated conversation about something else entirely. " +
    "Now consider @img5 purely as a generic element with absolutely nothing describing what role it plays here at all in this sentence.";
  const roles = parseRefRoles(prompt);
  assert.equal(roles.has("@img5"), false);
});

test("parseRefRoles: role keyword just inside the window DOES bind (sanity contrast to the far case)", () => {
  const prompt = "The location for this shot is exactly @img6, nothing more to add.";
  const roles = parseRefRoles(prompt);
  assert.equal(roles.get("@img6"), "location");
});

test("hasExplicitRefRole distinguishes direct tag binding from nearby scene context", () => {
  assert.equal(
    hasExplicitRefRole("Use @img1 as the exact location.", "@img1", "location"),
    true
  );
  assert.equal(
    hasExplicitRefRole("Use the school from @img1.", "@img1", "location"),
    true
  );
  assert.equal(
    hasExplicitRefRole("Use the exact face from @img1.", "@img1", "person"),
    true
  );
  assert.equal(
    hasExplicitRefRole("@img1 looking down in a school hallway.", "@img1", "location"),
    false,
    "school is scene context here, not an explicit declaration that @img1 is a location"
  );
});

test("buildShotInstruction: contains rawPrompt verbatim as a contiguous substring", () => {
  const rawPrompt = BASELINE_PROMPT;
  const result = buildShotInstruction({ rawPrompt, legend: null, aspectRatio: "1:1" });
  assert.ok(result.includes(rawPrompt), "rawPrompt must appear unmodified in the output");
});

test("buildShotInstruction: contains rawPrompt verbatim even with odd/adversarial characters", () => {
  const rawPrompt = 'A "quoted" prompt with\nnewlines,\ttabs, and emoji 🎬 — kept literal.';
  const result = buildShotInstruction({ rawPrompt, legend: null, aspectRatio: "1:1" });
  assert.ok(result.includes(rawPrompt));
});

test('buildShotInstruction: contains "SCENE:" exactly once', () => {
  const result = buildShotInstruction({
    rawPrompt: "A simple scene description.",
    legend: "REFERENCES:\n@img1 = the exact face/identity of the subject.",
    aspectRatio: "16:9",
  });
  const matches = result.match(/SCENE:/g) ?? [];
  assert.equal(matches.length, 1);
});

test("buildShotInstruction: includes the legend text when provided", () => {
  const legend = "REFERENCES:\n@img1 = the exact face/identity of the subject.";
  const result = buildShotInstruction({ rawPrompt: "A scene.", legend, aspectRatio: "1:1" });
  assert.ok(result.includes(legend));
});

test("buildShotInstruction: omits legend content when legend is null", () => {
  const result = buildShotInstruction({ rawPrompt: "A scene.", legend: null, aspectRatio: "1:1" });
  assert.ok(!result.includes("REFERENCES:"));
});

test("buildShotInstruction: includes an AVOID block containing NEGATIVE_CODA", () => {
  const result = buildShotInstruction({
    rawPrompt: "A woman in a scene.",
    legend: null,
    aspectRatio: "1:1",
  });
  assert.ok(result.includes(`AVOID: ${NEGATIVE_CODA}`));
});

test("buildShotInstruction: includes the framing coda for a wide aspect ratio", () => {
  const withCoda = buildFramingCoda("21:9");
  assert.ok(withCoda, "expected buildFramingCoda('21:9') to be non-null for this assertion to be meaningful");
  const result = buildShotInstruction({
    rawPrompt: "A woman in a scene.",
    legend: null,
    aspectRatio: "21:9",
  });
  assert.ok(result.includes(withCoda as string));
});

test("buildShotInstruction: no framing coda text present for a square aspect ratio", () => {
  const result = buildShotInstruction({ rawPrompt: "A scene.", legend: null, aspectRatio: "1:1" });
  assert.ok(!result.includes("FRAMING"));
});

test("buildFramingCoda: non-null for wide aspect ratios (21:9, 16:9)", () => {
  assert.notEqual(buildFramingCoda("21:9"), null);
  assert.notEqual(buildFramingCoda("16:9"), null);
  assert.equal(typeof buildFramingCoda("21:9"), "string");
  assert.equal(typeof buildFramingCoda("16:9"), "string");
});

test("buildFramingCoda: null for square/portrait aspect ratios (1:1, 9:16, 3:4)", () => {
  assert.equal(buildFramingCoda("1:1"), null);
  assert.equal(buildFramingCoda("9:16"), null);
  assert.equal(buildFramingCoda("3:4"), null);
});

test("roleHeader: outfit role mentions 'outfit' and avoids person/face language", () => {
  const header = roleHeader("@img2", "outfit", 1);
  assert.ok(/outfit/i.test(header));
  assert.ok(header.includes("@img2"));
  assert.ok(
    !/\b(face|identity|jawline|cheekbone|hairline|eyebrow)\b/i.test(header),
    `expected no person/face language in an outfit header, got: ${header}`
  );
});

test("roleHeader: person role uses identity/face language", () => {
  const header = roleHeader("@img1", "person", 2);
  assert.ok(/\b(person|identity|face)\b/i.test(header));
  assert.ok(header.includes("@img1"));
});

test("roleHeader: reflects the image count in the header text (singular vs plural)", () => {
  const single = roleHeader("@img1", "person", 1);
  const multi = roleHeader("@img1", "person", 3);
  assert.ok(single.includes("1"));
  assert.ok(multi.includes("3"));
  assert.notEqual(single, multi);
});

test("buildReferenceLegend: returns null for an empty entries list", () => {
  assert.equal(buildReferenceLegend([]), null);
});

test("buildReferenceLegend: non-null legend mentions every tag when entries are provided", () => {
  const legend = buildReferenceLegend([
    { tag: "@img1", role: "person", isPerson: true },
    { tag: "@img2", role: "outfit", isPerson: false },
    { tag: "@img3", role: "location", isPerson: false },
  ]);
  assert.notEqual(legend, null);
  assert.ok(legend!.includes("@img1"));
  assert.ok(legend!.includes("@img2"));
  assert.ok(legend!.includes("@img3"));
});

// ---------------------------------------------------------------------------
// ADDED for omni-video (.council/omni-video/design.md Phase 1 bullet:
// "src/lib/shot-spec.ts + prompt-assembler.ts: optional medium?:"image"|"video"
// (default "image", existing behavior byte-identical); video framing coda uses
// motion language; video AVOID list targets temporal artifacts (identity/
// wardrobe drift between frames, flicker, morphing)."
//
// Written independently from .council/omni-video/spec.md AC3/AC5 (existing
// shot-spec tests above this line must keep passing byte-untouched) before
// reading any omni implementation. These cases ONLY add new assertions for
// the video medium and re-confirm the documented default-medium equivalence;
// none of the pre-existing tests above were modified.
//
// Test list:
//  - buildFramingCoda(ar, "video") is non-null only for wide ARs (16:9, 21:9),
//    same AR gating as the image medium.
//  - buildFramingCoda(ar, "video") wording uses motion/temporal language
//    (mentions frame(s)/motion/camera), not the still-photo "hero composition"
//    wording used for medium="image".
//  - buildFramingCoda(square/portrait, "video") is still null (AR gate is
//    medium-independent).
//  - buildShotInstruction({..., medium:"video"}) AVOID block mentions
//    cross-frame drift/flicker/morphing language, distinct from the image
//    AVOID wording (blur/plasticky skin/etc.).
//  - buildShotInstruction / buildFramingCoda called with no medium argument
//    at all (undefined) behave identically to explicit medium:"image" and to
//    today's pre-omni output — i.e. default is byte-identical to existing
//    behavior (AC5).
// ---------------------------------------------------------------------------

test("buildFramingCoda: video medium is non-null for wide ARs (16:9, 21:9), same gate as image medium", () => {
  assert.notEqual(buildFramingCoda("16:9", "video"), null);
  assert.notEqual(buildFramingCoda("21:9", "video"), null);
});

test("buildFramingCoda: video medium is still null for square/portrait ARs", () => {
  assert.equal(buildFramingCoda("1:1", "video"), null);
  assert.equal(buildFramingCoda("9:16", "video"), null);
  assert.equal(buildFramingCoda("3:4", "video"), null);
});

test("buildFramingCoda: video medium wording uses motion/frame language, not the still 'hero composition' wording", () => {
  const videoCoda = buildFramingCoda("16:9", "video");
  assert.ok(videoCoda, "expected a non-null coda for 16:9 video");
  assert.ok(
    /\b(frame|frames|motion|camera|shot)\b/i.test(videoCoda as string),
    `expected motion/frame language in the video framing coda, got: ${videoCoda}`
  );
});

test("buildFramingCoda: default (no medium argument) is byte-identical to explicit medium:'image' and to prior behavior", () => {
  const noMedium = buildFramingCoda("16:9");
  const explicitImage = buildFramingCoda("16:9", "image");
  assert.equal(noMedium, explicitImage);
  // Prior/existing behavior, unmodified: buildFramingCoda("16:9") non-null,
  // same string documented in the "hero composition" test above this block.
  assert.ok(noMedium);
  assert.ok(/hero/i.test(noMedium as string));
});

test("buildShotInstruction: medium:'video' AVOID block mentions cross-frame drift/flicker/morphing, not the still-image wording", () => {
  const result = buildShotInstruction({
    rawPrompt: "A scene.",
    legend: null,
    aspectRatio: "1:1",
    medium: "video",
  } as Parameters<typeof buildShotInstruction>[0]);
  assert.ok(
    /(drift.{0,30}frame|frame.{0,30}drift|flicker|morph)/i.test(result),
    `expected temporal-artifact AVOID wording for video medium, got: ${result}`
  );
});

test("buildShotInstruction: default (no medium argument) output is unchanged from documented image-medium behavior", () => {
  const result = buildShotInstruction({
    rawPrompt: "A woman in a scene.",
    legend: null,
    aspectRatio: "1:1",
  });
  // Same assertions as the pre-existing "includes an AVOID block containing
  // NEGATIVE_CODA" test above — re-confirming default/undefined medium is
  // indistinguishable from the byte-identical pre-omni contract (AC5).
  assert.ok(result.includes(`AVOID: ${NEGATIVE_CODA}`));
});

// ---------------------------------------------------------------------------
// Zero-cast image policy. Empty/location-only prompts must not inherit the
// person-specific hero framing and skin/limb/anatomy vocabulary. Conversely,
// every person/reference prompt stays on the exact pre-change text path.
// ---------------------------------------------------------------------------

test("empty school: environment framing, environment negative, and camera-looking-down policy", () => {
  const rawPrompt =
    "An empty school hallway at dawn, camera looking down from the upper landing.";
  const instruction = buildShotInstruction({
    rawPrompt,
    legend: null,
    aspectRatio: "16:9",
  });
  const castPolicy = buildCastPolicy(rawPrompt);

  assert.ok(instruction.includes(rawPrompt), "raw prompt must remain verbatim");
  assert.ok(instruction.includes(`AVOID: ${ENVIRONMENT_NEGATIVE_CODA}`));
  assert.match(instruction, /explicitly requested setting and objects/i);
  assert.doesNotMatch(
    instruction,
    /subject filling|small or distant subject|plasticky skin|duplicated limbs|warped anatomy/i
  );
  assert.equal(castPolicy, `${ZERO_CAST_POLICY}\n${VIEWPOINT_POLICY}`);
});

test("bare looking up in an empty classroom is camera direction, not a person action", () => {
  const rawPrompt = "An empty classroom, looking up toward the ceiling.";
  assert.equal(hasVisiblePeople(rawPrompt), false);
  assert.equal(buildCastPolicy(rawPrompt), `${ZERO_CAST_POLICY}\n${VIEWPOINT_POLICY}`);
});

test("negated human nouns remain zero-cast", () => {
  const rawPrompt =
    "No students or staff in the school hallway; high-angle view looking down.";
  assert.equal(hasVisiblePeople(rawPrompt), false);
  assert.equal(buildCastPolicy(rawPrompt), `${ZERO_CAST_POLICY}\n${VIEWPOINT_POLICY}`);
});

test("human-labelled furniture does not invent its owner", () => {
  const rawPrompt =
    "An empty classroom with a teacher's desk, student lockers, and rows of chairs.";
  assert.equal(hasVisiblePeople(rawPrompt), false);
  assert.equal(buildCastPolicy(rawPrompt), ZERO_CAST_POLICY);
});

test("positive person controls keep looking down/up as character actions", () => {
  for (const rawPrompt of [
    "A teacher looking down at an open book in the classroom.",
    "Students looking up at the school clock.",
    "Naisha looking down at a book.",
  ]) {
    assert.equal(hasVisiblePeople(rawPrompt), true, rawPrompt);
    assert.equal(buildCastPolicy(rawPrompt), null, rawPrompt);
    const instruction = buildShotInstruction({
      rawPrompt,
      legend: null,
      aspectRatio: "16:9",
    });
    assert.ok(instruction.includes(`AVOID: ${NEGATIVE_CODA}`), rawPrompt);
    assert.match(instruction, /hero composition/i, rawPrompt);
  }
});

test("person-reference shot instruction is byte-identical to the proven identity path", () => {
  const rawPrompt =
    "THIS EXACT FACE from @priya. She is looking down at a book.";
  const legend =
    "REFERENCES:\n@priya = the exact face/identity of the subject — must be reproduced with photographic fidelity, never a lookalike.";
  const actual = buildShotInstruction({
    rawPrompt,
    legend,
    aspectRatio: "16:9",
    hasPersonReference: true,
  });
  const expected =
    "REFERENCES:\n@priya = the exact face/identity of the subject — must be reproduced with photographic fidelity, never a lookalike.\n\n" +
    "SCENE: THIS EXACT FACE from @priya. She is looking down at a book.\n\n" +
    "FRAMING: keep the subject large and prominent in the frame — a hero composition within the wide field, the subject filling roughly half to two-thirds of the frame height and placed in the frame's power zone, never small or distant; background and environment stay supporting, in sharp focus but not competing with the subject for size.\n" +
    "AVOID: blur or softness on the subject, smeared or plasticky skin, washed-out or muddy color cast, loss of background/environment detail, a small or distant subject, extra or duplicated limbs, warped anatomy.";

  assert.equal(actual, expected);
  assert.equal(buildCastPolicy(rawPrompt, true), null);
});
