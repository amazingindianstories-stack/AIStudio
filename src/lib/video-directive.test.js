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
