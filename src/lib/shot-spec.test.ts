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
  buildFramingCoda,
  buildShotInstruction,
  NEGATIVE_CODA,
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
  const result = buildShotInstruction({ rawPrompt: "A scene.", legend: null, aspectRatio: "1:1" });
  assert.ok(result.includes(`AVOID: ${NEGATIVE_CODA}`));
});

test("buildShotInstruction: includes the framing coda for a wide aspect ratio", () => {
  const withCoda = buildFramingCoda("21:9");
  assert.ok(withCoda, "expected buildFramingCoda('21:9') to be non-null for this assertion to be meaningful");
  const result = buildShotInstruction({ rawPrompt: "A scene.", legend: null, aspectRatio: "21:9" });
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
