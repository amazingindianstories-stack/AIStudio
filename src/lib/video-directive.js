/**
 * Shared shot directive for the video providers (Seedance native + Higgsfield).
 *
 * WHY THIS EXISTS
 * The two Seedance paths each grew their own hand-written directive —
 * `heroDirective` in providers/seedance.ts and VIDEO_IDENTITY_DIRECTIVE in
 * providers/higgsfield-mcp.ts. They said overlapping things in different words
 * and had already drifted (one framed a single "MAIN CHARACTER", the other
 * multiple tagged references). Identity scaffolding is worth keeping — it is
 * the measured lever — but it belongs in one place with one wording.
 *
 * THREE PROBLEMS THIS FIXES (reported 2026-07-28)
 *
 * 1. STYLE WAS ASSUMED PHOTOREAL. Both directives locked identity but neither
 *    ever told the model to follow the reference's *style*. Worse, the identity
 *    wording was photoreal vocabulary — "skin tone and texture (keep moles,
 *    scars, freckles)", "do not beautify, smooth, slim, de-age or idealize".
 *    Against an anime, cel-shaded, 3D-render or painterly reference that fights
 *    the reference: anime is smoothed and idealized *by construction*, so the
 *    directive was instructing the model to violate the very image it was told
 *    to match. Style is now locked to the reference explicitly and phrased so
 *    it holds for any medium, and the skin-texture clause only appears when the
 *    work is actually photographic.
 *
 *    Note the deliberate choice NOT to classify the reference's style with a
 *    vision call. It would cost money on the same rate-limited key the spend
 *    gate exists to protect (see spend-window.ts), and it is unnecessary: the
 *    model can already see the reference. Telling it to match what it sees is
 *    both cheaper and more accurate than telling it what we think it sees.
 *
 * 2. OUR CINEMATOGRAPHY OVERRODE THE USER'S. Both directives hardcoded
 *    "keep the subject in sharp foreground focus" and "keep background people
 *    softer and out of focus". Those are depth-of-field and focal decisions. A
 *    prompt asking for a wide establishing shot in deep focus, or a rack focus
 *    onto the crowd, directly contradicted them — and because both directives
 *    ALSO said "execute exactly as written", the model received two conflicting
 *    instructions and resolved them arbitrarily. Those defaults are now
 *    suppressed entirely when the prompt carries its own camera direction.
 *
 * 3. PRECEDENCE WAS UNSTATED AND UNPLACEABLE. Both were built as
 *    `DIRECTIVE + prompt`, so nothing could be said after the user's text —
 *    exactly where a precedence rule carries the most weight. This module owns
 *    the whole assembly instead, so the closing rule ("where anything above
 *    conflicts with the PROMPT, the PROMPT wins") lands last.
 *
 * The user's prompt is always passed through verbatim, never rewritten — same
 * contract as the SCENE block in prompt-assembler.ts.
 *
 * NOT YET BAKE-OFF MEASURED. The identity wording it inherits was measured;
 * this restructuring is reasoned, not A/B-tested, because a video bake-off
 * costs real generations. SEEDANCE_LEGACY_DIRECTIVE=1 restores the previous
 * behaviour on both paths without a deploy.
 *
 * PER-REFERENCE ROLE LEGEND (2026-08-17). Everything above treats every
 * reference as one undifferentiated group — every image is "the reference"
 * for both style and identity. That's fine for the common case (one
 * reference, or several angles of the same person), but it actively
 * misfires when a face/identity reference is attached alongside a style or
 * mood board with no explicit tagging: styleLock told the model to match
 * EVERY reference's medium (including the identity photo), and identityLock
 * told it every reference defines a face (including the style board) — the
 * same mixed-batch failure mode already fixed on the image path
 * (prompt-assembler.ts, 2026-08-17). Callers may now pass `refRoles`, a
 * `Map<number, role>` keyed by the 1-based image number as it appears in the
 * prompt's own `[image N]`/`<<<image_N>>>` tokens — built from the SAME
 * deterministic, free keyword scan the image path uses (`parseRefRoles` in
 * shot-spec.ts), never a vision call, for the same cost reason given above.
 * When at least one role is known AND the reference set is mixed (more than
 * one distinct role present), a short legend is emitted (reusing
 * shot-spec.ts's `buildReferenceLegend`) and styleLock/identityLock scope
 * their claims to the specifically-tagged reference(s) rather than the whole
 * set. A single reference, an all-one-role batch (several selfie angles), or
 * no resolvable roles at all (the common untagged case) all fall through to
 * the ORIGINAL generic wording, byte-identical to before this change — so
 * this is additive, not a rewrite, and needs no bake-off to ship safely.
 */

import { buildReferenceLegend } from "./shot-spec";

/** How a provider expects reference images to be named inside the prompt.
 *  BytePlus reads "[image 1]"; Higgsfield reads "<<<image_1>>>". */
 

function tagExample(syntax) {
  return syntax === "angle" ? "<<<image_1>>>, <<<image_2>>>" : "[image 1], [image 2]";
}

/**
 * Does the prompt already carry its own camera / staging direction?
 *
 * Used only to decide whether our default focal guidance is added, so the error
 * cost is asymmetric and the vocabulary is tuned accordingly: a false negative
 * just keeps today's defaults, while a false positive merely drops guidance the
 * user did not ask for. Terms are kept specific for that reason — bare "shot"
 * would fire on "gunshot", bare "focus" on "focus on her goal".
 */
// Deliberately NOT in this list: bare "framing" and "blocking". Both are
// ordinary English ("blocking the door", "framing the photograph on the wall")
// and were measured firing as false positives; in a genuine camera instruction
// they almost always co-occur with a term below, so nothing is lost.
const CAMERA_RE =
  /\b(dolly|tracking shot|trucking|crane shot|jib|steadicam|handheld|whip pan|pan (?:left|right|across|up|down)|tilt (?:up|down)|push in|pull (?:out|back)|zoom (?:in|out)|rack focus|deep focus|shallow focus|shallow depth|depth of field|bokeh|close[- ]up|extreme close|wide shot|medium shot|long shot|establishing shot|over[- ]the[- ]shoulder|point of view|pov shot|bird'?s[- ]eye|worm'?s[- ]eye|low angle|high angle|dutch angle|aerial|drone shot|orbit(?:ing)? shot|locked[- ]off|static shot|slow motion|time[- ]lapse|anamorphic|f\/\d|\d+mm lens|focal length|camera (?:move|movement|angle)|shot on)\b/i;

export function hasCameraDirection(prompt) {
  return CAMERA_RE.test(prompt);
}

/**
 * Does the prompt name an explicit visual style or medium?
 *
 * When it does, the prompt's style is authoritative over the reference's — the
 * user is deliberately restyling (e.g. a photo reference rendered as anime),
 * and silently forcing the reference's medium would defeat that intent.
 */
export function hasExplicitStyle(prompt) {
  return /\b(anime|manga|cartoon|comic|graphic novel|cel[- ]shaded|toon|3d render|cgi|claymation|stop[- ]motion|puppet|pixel art|voxel|low[- ]poly|watercolou?r|oil painting|gouache|pastel|charcoal|pencil sketch|line art|ink(?:ed)? drawing|illustrat(?:ed|ion)|painterly|storyboard|blueprint|wireframe|noir|silhouette|claymore|ukiyo[- ]e|impressionist|surrealist|photoreal(?:istic)?|live[- ]action|documentary style|found footage|vhs|super ?8|16mm|35mm film|film grain|stylized|stylised)\b/i.test(
    prompt
  );
}

/** The domain fence. Style-neutral on purpose: it names every medium so it can
 *  never be read as "photoreal only". */
const DOMAIN_LOCK =
  "DOMAIN — FILMMAKING ONLY: you are a dedicated filmmaking video renderer, " +
  "not a general-purpose model. Your sole domain is producing film shots in " +
  "any medium — live-action, photoreal, animated, cartoon, illustrated, " +
  "stop-motion or fully stylized. Draw only on filmmaking craft: " +
  "cinematography, lensing, camera movement, lighting, blocking, continuity, " +
  "production design, wardrobe, makeup, VFX and animation. Treat the prompt " +
  "strictly as a shot specification to render; bring in no outside knowledge, " +
  "commentary, captions, watermarks or UI elements.";

/** Grammar helper for a joined tag list ("[image 1]" or "[image 1], [image 3]")
 *  so callers don't hand-branch singular/plural agreement at every use site. */
function tagPhrase(entries) {
  const list = entries.map((e) => e.tag).join(", ");
  const single = entries.length === 1;
  return {
    list,
    verb: single ? "defines" : "define",
    pronoun: single ? "its" : "their",
    itThey: single ? "it" : "they",
    thisThese: single ? "this tagged reference" : "these tagged references",
  };
}

function styleLock(refCount, promptNamesStyle, entries = []) {
  const refs = refCount > 1 ? "reference images" : "reference image";
  if (promptNamesStyle) {
    // The user is deliberately restyling. Say so explicitly rather than letting
    // two style sources fight — take identity from the reference, look from the
    // prompt.
    return (
      `STYLE — THE PROMPT WINS: the prompt names an explicit visual style or ` +
      `medium. Render in that style. Take from the ${refs} only WHO and WHAT ` +
      `the subjects are — their identity, design, wardrobe and defining ` +
      `features — and re-render them in the style the prompt names. Do not ` +
      `override the prompt's style with the ${refs}' medium.`
    );
  }
  // Mixed batch (2026-08-17): when at least one reference is tagged STYLE
  // and the set also carries a different role (typically an identity photo),
  // scope style extraction to the tagged style reference(s) only — see the
  // file header. An all-style or fully-untagged batch falls through below,
  // unchanged.
  const styleEntries = entries.filter((e) => e.role === "style");
  const mixed = new Set(entries.map((e) => e.role)).size > 1;
  if (styleEntries.length && mixed) {
    const { list, verb, itThey, thisThese } = tagPhrase(styleEntries);
    return (
      `STYLE — FOLLOW ${thisThese.toUpperCase()} ONLY (unless the PROMPT ` +
      `names a different style, in which case the PROMPT wins): ${list} ` +
      `${verb} the visual style of this shot, not just its content. ` +
      `Reproduce ${itThey === "it" ? "its" : "their"} medium and rendering ` +
      `exactly — whether photographic, anime, cel-shaded, 3D-rendered, ` +
      `illustrated, painterly, stop-motion or any other treatment — ` +
      `including line quality, shading model, colour palette, level of ` +
      `detail and degree of stylization. Do NOT take style cues from any ` +
      `other tagged reference — the other references define identity, ` +
      `outfit, location or subject matter only, never style. Do NOT convert ` +
      `${list} to photorealism, and do not add realistic skin, lighting or ` +
      `texture detail ${itThey} ${itThey === "it" ? "does" : "do"} not have.`
    );
  }
  return (
    `STYLE — FOLLOW THE ${refCount > 1 ? "REFERENCES" : "REFERENCE"} (unless ` +
    `the PROMPT names a different style, in which case the PROMPT wins): the ` +
    `${refs} define the visual style of this shot, not just its content. ` +
    `Reproduce their medium and rendering exactly — whether photographic, ` +
    `anime, cel-shaded, 3D-rendered, illustrated, painterly, stop-motion or ` +
    `any other treatment — including line quality, shading model, colour ` +
    `palette, level of detail and degree of stylization. Do NOT convert the ` +
    `${refs} to photorealism, and do not add realistic skin, lighting or ` +
    `texture detail that the ${refs} do not have. If the ${refs} are stylized, ` +
    `the finished shot is stylized to exactly the same degree.`
  );
}

/**
 * Identity lock, phrased so it holds in any medium.
 *
 * The inherited wording leaned on photographic detail ("skin texture", "moles,
 * scars, freckles", "do not smooth or idealize"), which is meaningless or
 * actively wrong for a drawn reference. Identity here is "the same character as
 * depicted" — features, proportions, design — and the photographic clause is
 * appended only when the prompt indicates photoreal work.
 */
function identityLock(
  refCount,
  syntax,
  photoreal,
  entries = []
) {
  const multi = refCount > 1;
  const refs = multi ? "reference images" : "reference image";
  const personEntries = entries.filter((e) => e.isPerson);
  const mixed = new Set(entries.map((e) => e.role)).size > 1;

  let text;
  if (personEntries.length && mixed) {
    // Mixed batch (2026-08-17): scope the identity claim to the tagged
    // person reference(s) only. This is the exact bug reported in
    // production — an untagged style/mood board sitting next to a face
    // reference was being read as an additional face. Other roles
    // (outfit/location/style/prop) are named explicitly and excluded.
    const { list, verb, pronoun, thisThese } = tagPhrase(personEntries);
    const otherEntries = entries.filter((e) => !e.isPerson);
    text =
      `IDENTITY LOCK: ${thisThese} — ${list} — ${verb} the ` +
      `exact, fixed appearance of the people ${personEntries.length > 1 ? "they show" : "it shows"}. ` +
      (otherEntries.length
        ? `The other tagged reference${otherEntries.length > 1 ? "s" : ""} ` +
          `(${otherEntries.map((e) => `${e.tag} = ${e.role}`).join(", ")}) ` +
          `contribute${otherEntries.length > 1 ? "" : "s"} only their own ` +
          `content — not an additional face or person. `
        : "") +
      `In EVERY frame, each person referenced by ${list} keeps the same face ` +
      `and features as depicted in ${pronoun} reference — the same facial ` +
      `structure and proportions, eye shape and colour, brows, nose, mouth, ` +
      `hair colour and hairstyle, facial hair, body build, apparent age, and ` +
      `the same distinguishing marks the reference shows — unmistakably the ` +
      `SAME character, never a lookalike. Keep that subject's wardrobe and ` +
      `jewelry as referenced unless the prompt explicitly changes them, with ` +
      `zero identity or wardrobe drift between frames. Never blend or swap ` +
      `features between different references, and never duplicate a ` +
      `referenced subject. Anyone else on screen is a DIFFERENT individual ` +
      `who must not resemble a referenced subject.`;
  } else {
    text =
      `IDENTITY LOCK: the ${refs} define the exact, fixed appearance of the ` +
      `${multi ? "people and elements they show" : "subject shown"}. ` +
      (multi
        ? `When the prompt tags them (${tagExample(syntax)}, …) the tags map to ` +
          `the ${refs} in order. `
        : "") +
      `In EVERY frame, each referenced subject keeps the same face and features ` +
      `as depicted in its reference — the same facial structure and proportions, ` +
      `eye shape and colour, brows, nose, mouth, hair colour and hairstyle, ` +
      `facial hair, body build, apparent age, and the same distinguishing marks ` +
      `the reference shows — unmistakably the SAME character, never a lookalike. ` +
      `Keep each subject's wardrobe and jewelry as referenced unless the prompt ` +
      `explicitly changes them, with zero identity or wardrobe drift between ` +
      `frames. Never blend or swap features between different references, and ` +
      `never duplicate a referenced subject. Anyone else on screen is a ` +
      `DIFFERENT individual who must not resemble a referenced subject.`;
  }
  if (photoreal) {
    text +=
      ` Because this shot is photographic, preserve real skin tone and texture ` +
      `including moles, scars and freckles; do not beautify, smooth, slim or ` +
      `de-age.`;
  }
  return text;
}

/**
 * Default focal guidance, phrased to yield on its own.
 *
 * hasCameraDirection removes this block when it is confident, but a regex has
 * no comprehension — it will miss "she drifts out of focus as the camera falls
 * back". So the text carries its own conditional too, delegating the judgement
 * to the model, which can actually read the prompt. Detection is therefore only
 * an optimisation (shorter directive, no conflicting text at all); correctness
 * does not depend on it, and a missed detection degrades to a default that
 * still defers rather than to a contradiction.
 */
const DEFAULT_FRAMING =
  "FRAMING (default — apply ONLY where the PROMPT does not specify framing, " +
  "focus or camera work; if it does, follow the PROMPT and ignore this " +
  "entirely): keep the referenced subject in sharp focus as the clear focal " +
  "point, and render background people softer so they never compete with or " +
  "are mistaken for it.";

/** Acknowledges the user's own camera work and forbids substituting ours. */
const USER_FRAMING =
  "FRAMING — THE PROMPT WINS: the prompt contains explicit camera, framing or " +
  "staging direction. Follow it exactly, including any focus, depth-of-field, " +
  "lens, angle and movement it specifies. Do not substitute conventional " +
  "coverage for what it asks for, and do not add focal effects it did not " +
  "request.";

const LITERAL =
  "LITERAL PROMPT: the prompt is a binding specification — execute it exactly " +
  "as written. Every stated subject, count, wardrobe item, colour, action and " +
  "spatial position appears precisely as specified; add nothing, drop " +
  "nothing, substitute nothing. Anything under \"NEGATIVE PROMPT\" or phrased " +
  "as \"no …\" is strictly forbidden in every frame.";

/**
 * The closing precedence rule.
 *
 * Placed after the prompt on purpose. Everything above is scaffolding we wrote;
 * the prompt is what the user actually asked for, and when the two disagree the
 * user is right. Trailing position is also where instruction-following models
 * weight a rule most heavily — the old `DIRECTIVE + prompt` shape had nowhere
 * to put this at all.
 */
const PRECEDENCE =
  "PRECEDENCE: the PROMPT above is authoritative. Where anything in these " +
  "instructions conflicts with it — style, medium, framing, focus, camera " +
  "movement, pacing or staging — follow the PROMPT and disregard the " +
  "conflicting instruction. These instructions exist to fill gaps the PROMPT " +
  "leaves open, never to override what it states.";

/** "[image 1]" or "<<<image_1>>>" depending on the provider's tag syntax —
 *  same convention as tagExample, one index at a time. */
function refToken(index, syntax) {
  return syntax === "angle" ? `<<<image_${index}>>>` : `[image ${index}]`;
}

/** Turn a caller-supplied `Map<number, role>` into shot-spec.ts-shaped legend
 *  entries. Trusts whatever indices the caller provides — the caller (each
 *  provider's own reference-resolution logic) is what knows which numbers
 *  are actually valid in that provider's prompt, not this module. Returns
 *  [] for an absent/empty map, which every downstream consumer treats as
 *  "no role information available" and falls back to generic wording. */
function legendEntries(refRoles, syntax) {
  if (!refRoles || !refRoles.size) return [];
  return [...refRoles.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, role]) => ({
      tag: refToken(index, syntax),
      role,
      isPerson: role === "person",
    }));
}

/**
 * Build the full text sent to a video provider: scaffolding, then the user's
 * prompt verbatim, then the precedence rule.
 *
 * With no references this returns the prompt untouched — identity and style
 * locks describe references that do not exist, and a bare text-to-video prompt
 * should not be buried in scaffolding about them.
 *
 * `refRoles` (optional): `Map<number, "person"|"outfit"|"location"|"style"|
 * "prop"|"object">` keyed by the 1-based image number as it appears in the
 * provider's own `[image N]`/`<<<image_N>>>` tokens. See the file header
 * ("PER-REFERENCE ROLE LEGEND") for what this changes and why it's safe to
 * omit.
 */
export function buildVideoDirective(input) {
  const prompt = input.prompt.trim();
  if (input.refCount <= 0) return prompt;

  const promptNamesStyle = hasExplicitStyle(prompt);
  const userDirectsCamera = hasCameraDirection(prompt);
  // Only claim the shot is photographic when the prompt says so. Silence is not
  // evidence of photorealism — that assumption is the original bug.
  const photoreal = /\b(photoreal(?:istic)?|live[- ]action|documentary style|found footage|35mm film|16mm|super ?8|vhs|film grain)\b/i.test(
    prompt
  );

  const entries = legendEntries(input.refRoles, input.tagSyntax);
  // A legend is only useful once there's more than one role to disambiguate
  // between — a single reference or an all-one-role batch needs no legend at
  // all, and emitting one anyway would add text with nothing to clarify.
  const mixed = new Set(entries.map((e) => e.role)).size > 1;
  const legend = mixed ? buildReferenceLegend(entries) : null;

  const blocks = [
    DOMAIN_LOCK,
    ...(legend ? [legend] : []),
    styleLock(input.refCount, promptNamesStyle, entries),
    identityLock(input.refCount, input.tagSyntax, photoreal, entries),
    userDirectsCamera ? USER_FRAMING : DEFAULT_FRAMING,
    LITERAL,
    `PROMPT:\n${prompt}`,
    PRECEDENCE,
  ];
  return blocks.join("\n\n");
}
