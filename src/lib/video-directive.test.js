import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVideoDirective,
  hasCameraDirection,
  hasExplicitStyle,
} from "./video-directive";

const build = (prompt, refCount = 1) =>
  buildVideoDirective({ prompt, refCount, tagSyntax: "bracket" });

// ── the user's prompt is never altered ──────────────────────────────────────

test("the prompt is passed through verbatim, never rewritten", () => {
  const prompt = "A woman in a red saree walks through Chowpatty at dusk.";
  assert.ok(build(prompt).includes(prompt));
});

test("with no references the prompt is returned completely untouched", () => {
  const prompt = "Rain on a window, slow push in.";
  assert.equal(buildVideoDirective({ prompt, refCount: 0, tagSyntax: "angle" }), prompt);
});

// ── 1. style follows the reference, not a photoreal default ─────────────────

test("style block tells the model to reproduce the reference's medium", () => {
  const out = build("She turns to face the camera.");
  assert.match(out, /STYLE — FOLLOW THE REFERENCE/);
  assert.match(out, /anime, cel-shaded, 3D-rendered, illustrated, painterly/);
  assert.match(out, /Do NOT convert the reference image to photorealism/);
});

test("photoreal-only skin language is absent unless the shot is photographic", () => {
  // This was the original bug: "keep moles, scars, freckles" and "do not
  // smooth or idealize" fight an anime reference, which is smoothed by design.
  const stylized = build("She turns to face the camera.");
  assert.doesNotMatch(stylized, /moles, scars and freckles/);
  assert.doesNotMatch(stylized, /do not beautify, smooth, slim or de-age/i);

  const photo = build("Photorealistic 35mm film shot, she turns to camera.");
  assert.match(photo, /moles, scars and freckles/);
});

test("a prompt naming its own style overrides the reference's medium", () => {
  const out = build("Render as anime: she turns to face the camera.");
  assert.match(out, /STYLE — THE PROMPT WINS/);
  assert.match(out, /re-render them in the style the prompt names/);
  // Identity still comes from the reference — only the look changes.
  assert.match(out, /IDENTITY LOCK/);
});

// ── 2. the user's cinematography wins over ours ─────────────────────────────

test("our default framing is dropped when the prompt directs the camera", () => {
  const out = build("Wide establishing shot in deep focus, the crowd fills frame.");
  assert.match(out, /FRAMING — THE PROMPT WINS/);
  // The contradicting default must be gone, not merely outranked.
  assert.doesNotMatch(out, /keep the referenced subject in sharp focus/i);
});

test("the default framing applies when the prompt says nothing about camera", () => {
  const out = build("She laughs and looks away.");
  assert.match(out, /FRAMING \(default/);
  assert.match(out, /keep the referenced subject in sharp focus/i);
});

test("even the default framing yields on its own, so a missed detection cannot contradict the prompt", () => {
  // Belt and braces: a regex cannot catch every phrasing of camera intent, so
  // the block delegates the conditional to the model as well.
  const out = build("She laughs and looks away.");
  assert.match(out, /apply ONLY where the PROMPT does not specify/);
});

// ── 3. precedence: user intent outranks our injection ──────────────────────

test("the precedence rule is present and lands AFTER the prompt", () => {
  const prompt = "She laughs and looks away.";
  const out = build(prompt);
  assert.match(out, /PRECEDENCE: the PROMPT above is authoritative/);
  assert.ok(
    out.indexOf(prompt) < out.indexOf("PRECEDENCE:"),
    "precedence must trail the prompt, where it carries the most weight"
  );
});

test("precedence explicitly names the dimensions our scaffolding could clash on", () => {
  const out = build("She laughs.");
  assert.match(out, /style, medium, framing, focus, camera movement, pacing or staging/);
});

// ── identity lock survives, and stays scoped to identity ───────────────────

test("identity lock is retained — it is the measured lever, not the thing being loosened", () => {
  const out = build("She walks through the market.");
  assert.match(out, /IDENTITY LOCK/);
  assert.match(out, /unmistakably the SAME character, never a lookalike/);
});

test("multi-reference prompts get the tag-mapping clause in provider syntax", () => {
  const bracket = buildVideoDirective({
    prompt: "[image 1] greets [image 2].",
    refCount: 2,
    tagSyntax: "bracket",
  });
  assert.match(bracket, /\[image 1\], \[image 2\]/);

  const angle = buildVideoDirective({
    prompt: "<<<image_1>>> greets <<<image_2>>>.",
    refCount: 2,
    tagSyntax: "angle",
  });
  assert.match(angle, /<<<image_1>>>, <<<image_2>>>/);
});

test("single-reference prompts omit the tag-mapping clause as noise", () => {
  assert.doesNotMatch(build("She waves.", 1), /the tags map to/);
});

// ── detectors ──────────────────────────────────────────────────────────────

test("hasCameraDirection: fires on real camera vocabulary", () => {
  for (const p of [
    "slow dolly in on her face",
    "rack focus to the background",
    "extreme close-up of the hands",
    "shot on a 35mm lens",
    "low angle, handheld",
    "aerial drone shot over the temple",
    "deep focus wide shot",
  ]) {
    assert.equal(hasCameraDirection(p), true, `expected camera direction in: ${p}`);
  }
});

test("hasCameraDirection: does not fire on incidental words", () => {
  // False positives cost the user their default guidance, so the vocabulary is
  // deliberately specific — bare "shot"/"focus" must not trigger.
  for (const p of [
    "a gunshot rings out",
    "she tries to focus on her work",
    "he was shot in the film's opening",
    "the panning of gold in the river",
  ]) {
    assert.equal(hasCameraDirection(p), false, `unexpected camera match in: ${p}`);
  }
});

test("hasExplicitStyle: recognises named media and treatments", () => {
  for (const p of [
    "in anime style",
    "a watercolour dream sequence",
    "claymation short",
    "cel-shaded action scene",
    "shot on VHS",
    "photorealistic portrait",
  ]) {
    assert.equal(hasExplicitStyle(p), true, `expected style in: ${p}`);
  }
});

test("hasExplicitStyle: stays quiet on ordinary scene description", () => {
  assert.equal(hasExplicitStyle("She walks through a crowded market at dusk."), false);
});

test("hasCameraDirection: ordinary English uses of 'blocking' and 'framing' do not fire", () => {
  // Measured false positives — they would silently strip the user's default
  // framing guidance for a prompt that never mentioned the camera.
  assert.equal(hasCameraDirection("he stands blocking the door"), false);
  assert.equal(hasCameraDirection("framing the photograph on the wall"), false);
});

// ── temporal staging + camera-movement vocabulary (2026-08-17, Phase 2.1) ──

test("TEMPORAL STAGING block is present whenever there is at least one reference", () => {
  const out = build("She laughs and looks away.");
  assert.match(out, /TEMPORAL STAGING \(apply ONLY where the PROMPT does not already stage/);
  assert.match(out, /distribute the prompt's action smoothly across the FULL duration/i);
});

test("TEMPORAL STAGING is absent for a bare text-to-video prompt (refCount 0) — untouched, as before", () => {
  const prompt = "Rain on a window, slow push in.";
  const out = buildVideoDirective({ prompt, refCount: 0, tagSyntax: "bracket" });
  assert.equal(out, prompt);
  assert.doesNotMatch(out, /TEMPORAL STAGING/);
});

test("TEMPORAL STAGING self-conditions rather than being regex-gated — always emitted even when the prompt already stages its own beats, deferring to the model", () => {
  // No detector function exists for this (see file header) — the text itself
  // carries the "apply ONLY where..." conditional, same belt-and-braces
  // pattern as DEFAULT_FRAMING's own fallback wording.
  const out = build("First she enters the room, then pauses, and finally sits down.");
  assert.match(out, /TEMPORAL STAGING \(apply ONLY where the PROMPT does not already stage/);
});

test("default camera-movement guidance appears alongside default framing when the prompt gives no camera direction", () => {
  const out = build("She laughs and looks away.");
  assert.match(out, /Hold ONE deliberate camera treatment for the whole shot/);
  assert.match(out, /rather than unmotivated cuts, random handheld shake/);
});

test("default camera-movement guidance is dropped (not just outranked) when the prompt directs the camera", () => {
  const out = build("Wide establishing shot in deep focus, the crowd fills frame.");
  assert.doesNotMatch(out, /Hold ONE deliberate camera treatment/);
});

test("block ordering: TEMPORAL STAGING lands after FRAMING and before LITERAL PROMPT", () => {
  const out = build("She laughs and looks away.");
  const framingPos = out.indexOf("FRAMING (default");
  const stagingPos = out.indexOf("TEMPORAL STAGING");
  const literalPos = out.indexOf("LITERAL PROMPT:");
  assert.ok(framingPos > -1 && framingPos < stagingPos && stagingPos < literalPos);
});

// ── per-reference role legend (2026-08-17, Phase 1.3) ───────────────────────
//
// Fix for the video-side half of the mixed-batch style-drift defect (see
// prompt-assembler.test.js for the image-side fix). An identity reference
// tagged alongside an untagged/differently-tagged style or location board
// must not have both locks address "the references" as one undifferentiated
// group — see video-directive.ts's "PER-REFERENCE ROLE LEGEND" header.

test("refRoles present but all-one-role (e.g. two selfie angles): still falls back to generic wording, no legend", () => {
  const refRoles = new Map([[1, "person"], [2, "person"]]);
  const out = buildVideoDirective({
    prompt: "[image 1] and [image 2] laughing together",
    refCount: 2,
    tagSyntax: "bracket",
    refRoles,
  });
  assert.match(out, /STYLE — FOLLOW THE REFERENCES \(unless/);
  assert.match(out, /IDENTITY LOCK: the reference images define the exact, fixed appearance of the people and elements they show\./);
  assert.doesNotMatch(out, /REFERENCES:\n/);
});

test("mixed batch (person + style, bracket syntax): emits a legend and scopes both locks to the tagged references", () => {
  const refRoles = new Map([[1, "person"], [2, "style"]]);
  const out = buildVideoDirective({
    prompt: "[image 1] dances under neon light in the mood of [image 2]",
    refCount: 2,
    tagSyntax: "bracket",
    refRoles,
  });

  // Legend present, in order, before the locks.
  assert.match(out, /REFERENCES:\n\[image 1\] = the exact face\/identity of the subject.*\n\[image 2\] = the exact visual style\/grade to match\./);

  // Style scoped to [image 2] only, and explicitly excludes other references.
  assert.match(out, /STYLE — FOLLOW THIS TAGGED REFERENCE ONLY/);
  assert.match(out, /\[image 2\] defines the visual style of this shot/);
  assert.match(out, /Do NOT take style cues from any other tagged reference/);
  assert.doesNotMatch(out, /STYLE — FOLLOW THE REFERENCES \(unless/);

  // Identity scoped to [image 1] only, and names the other reference's role.
  assert.match(out, /IDENTITY LOCK: this tagged reference — \[image 1\] — defines the exact, fixed appearance of the people it shows\./);
  assert.match(out, /\(\[image 2\] = style\) contributes only their own content — not an additional face or person\./);
  assert.doesNotMatch(out, /IDENTITY LOCK: the reference images define the exact, fixed appearance of the people and elements they show\./);

  // Legend ordering: DOMAIN_LOCK, then legend, then style/identity — legend
  // must appear before both locks.
  const legendPos = out.indexOf("REFERENCES:\n");
  const stylePos = out.indexOf("STYLE —");
  const identityPos = out.indexOf("IDENTITY LOCK:");
  assert.ok(legendPos > -1 && legendPos < stylePos && stylePos < identityPos);
});

test("mixed batch, angle syntax (Higgsfield): tokens rendered as <<<image_N>>>", () => {
  const refRoles = new Map([[1, "person"], [2, "location"]]);
  const out = buildVideoDirective({
    prompt: "<<<image_1>>> walks through <<<image_2>>>",
    refCount: 2,
    tagSyntax: "angle",
    refRoles,
  });
  assert.match(out, /REFERENCES:\n<<<image_1>>> = the exact face\/identity of the subject.*\n<<<image_2>>> = the exact location\/setting of the scene\./);
  assert.match(out, /IDENTITY LOCK: this tagged reference — <<<image_1>>> — defines the exact, fixed appearance/);
  assert.match(out, /\(<<<image_2>>> = location\) contributes only their own content/);
});

test("mixed batch with a non-contiguous/out-of-order refRoles map: legend still renders in ascending index order", () => {
  const refRoles = new Map([[3, "style"], [1, "person"]]);
  const out = buildVideoDirective({
    prompt: "[image 1] in the style of [image 3]",
    refCount: 2, // only 2 images were actually attached (a tagged subset)
    tagSyntax: "bracket",
    refRoles,
  });
  const legendBlock = out.match(/REFERENCES:\n([^]*?)\n\n/)[1];
  assert.equal(legendBlock, "[image 1] = the exact face/identity of the subject — must be reproduced with exact fidelity to the reference and in its medium, never a lookalike.\n[image 3] = the exact visual style/grade to match.");
});

test("mixed batch with multiple person-tagged references: plural grammar (define/they/their)", () => {
  const refRoles = new Map([[1, "person"], [2, "person"], [3, "outfit"]]);
  const out = buildVideoDirective({
    prompt: "[image 1] and [image 2] wearing [image 3]",
    refCount: 3,
    tagSyntax: "bracket",
    refRoles,
  });
  assert.match(out, /IDENTITY LOCK: these tagged references — \[image 1\], \[image 2\] — define the exact, fixed appearance of the people they show\./);
});

test("promptNamesStyle still wins over refRoles-based style scoping (prompt is always authoritative)", () => {
  const refRoles = new Map([[1, "person"], [2, "style"]]);
  const out = buildVideoDirective({
    prompt: "[image 1] rendered as anime, inspired by [image 2]",
    refCount: 2,
    tagSyntax: "bracket",
    refRoles,
  });
  assert.match(out, /STYLE — THE PROMPT WINS/);
  assert.doesNotMatch(out, /STYLE — FOLLOW THIS TAGGED REFERENCE ONLY/);
});
