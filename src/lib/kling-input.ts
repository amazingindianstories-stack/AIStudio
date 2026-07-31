/**
 * Pure builder: turns an AssembledPrompt (the structure Nano Banana Pro
 * consumes — role-labeled reference groups, identity tiles, shot-spec codas)
 * into what Kling's /v1/images/generations actually takes: ONE reference image
 * and ONE prompt string.
 *
 * Kling has no multi-part content, so the binding NBP gets for free — a text
 * header sitting immediately before each group's images — has nowhere to live.
 * Everything here exists to reconstruct that binding inside the single prompt
 * field. Three faults it fixes, all measured against real generations on
 * 2026-07-31:
 *
 * 1. **Saved @slug assets never reached Kling at all.** The route iterated the
 *    raw `referenceImages` uploads and never read `assembled.groups`, which is
 *    where an @slug asset lands. A prompt reading "use the supplied Shiv
 *    wardrobe sheet as the highest-priority identity reference" was sent with
 *    zero images attached. Counting groups instead is the fix, and it also means
 *    the one-reference limit is enforced against what the user actually
 *    referenced rather than against how they happened to attach it.
 *
 * 2. **Tags went to Kling as literal machine syntax.** `assembled.instruction`
 *    is the raw prompt verbatim, so Kling received the strings "@img1",
 *    "@img2" and "@img1-inspired" with a single unlabelled image and no legend.
 *    Every tag that resolves to the reference is rewritten to plain language.
 *
 * 3. **`shotInstruction` was ignored.** Built whenever PROMPT_SHOT_SPEC=1 and
 *    used by both gemini.ts and omni-input.ts, but the Kling branch took the raw
 *    prompt instead. Same precedence rule as those two: it already carries its
 *    own "SCENE:" prefix, so it is used verbatim and never re-wrapped.
 *
 * Identity TILES are deliberately not sent. They are a Gemini-specific lever —
 * that model ingests every image as one flat ~258-token tile, so extra face
 * crops buy real bandwidth. Kling takes one image; spending it on a crop instead
 * of the user's actual reference would be a straight downgrade.
 */
import { KLING_MAX_REFERENCE_IMAGES } from "./config";
import { MENTION_REGEX, TAG_REGEX } from "./mentions";
import type { AssembledImage, AssembledPrompt } from "./prompt-assembler";

export { KLING_MAX_REFERENCE_IMAGES };

/** What every resolved reference tag becomes in the prompt text. Kling only
 *  ever has one image, so a single unambiguous phrase is enough — and unlike
 *  "@img1" it is language the model already understands. */
const REFERENCE_PHRASE = "the reference image";

/**
 * The role rule prepended to the prompt, standing in for the group header.
 *
 * Condensed from KIND_RULE/ROLE_RULE in prompt-assembler.ts / shot-spec.ts
 * rather than reused verbatim: those run to ~700 characters, and Kling's whole
 * prompt budget is 2500 with real prompts here already reaching 3300. Long
 * scaffolding would push working prompts over the cap, so this keeps the
 * measured identity anchors (same individual, not a lookalike, not idealised,
 * same medium as the reference) and drops the enumeration.
 *
 * `identity` rather than a role enum because groups only carry a role when
 * PROMPT_SHOT_SPEC=1, and that flag is off in production — `identity` is set on
 * both paths.
 */
const PERSON_RULE =
  "reproduce this exact person — same face and bone structure, jawline, " +
  "hairline, eyes, nose, lips, facial hair, hairstyle, build and apparent age, " +
  "plus the distinguishing marks shown, and the same medium and rendering " +
  "style as the reference. The same individual, never a lookalike, and never " +
  "beautified, slimmed or de-aged relative to the reference";

const SUBJECT_RULE =
  "reproduce exactly what this shows — same shapes, colours, materials, " +
  "patterns and detailing, in the same medium and rendering style";

export interface KlingInput {
  /** Prompt text to send as `prompt`. Not length-checked here — the provider
   *  enforces Kling's 2500-character cap, with both numbers in the message. */
  prompt: string;
  /** The single reference, or undefined for text-to-image. */
  reference?: AssembledImage;
}

/** Escape a tag for use inside a RegExp. Slugs are [a-z0-9_-] and @imgN is
 *  digits, so nothing here is currently metacharacter-bearing — but the tag
 *  comes from user text via an asset slug, so it is escaped anyway. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildKlingInput(
  assembled: AssembledPrompt,
  modelDisplay: string
): KlingInput {
  const groups = assembled.groups.filter((g) => g.images.length > 0);
  const total = groups.reduce((n, g) => n + g.images.length, 0);

  if (total > KLING_MAX_REFERENCE_IMAGES) {
    // Loud, and it names both what was counted and a way forward — the image-cap
    // precedent from gemini.ts. Never silently keep the first and drop the rest:
    // the result would be inexplicable to whoever wrote the prompt.
    const named = groups.map((g) => g.tag).join(", ");
    throw new Error(
      `${modelDisplay} accepts ${KLING_MAX_REFERENCE_IMAGES} reference image, ` +
        `but this prompt resolved to ${total} (${named}). Kling's ` +
        `multi-reference mode is a different model (kling-v3-omni) that is not ` +
        `available here — use Nano Banana Pro for multi-reference prompts, or ` +
        `reduce this one to a single reference.`
    );
  }

  const group = groups[0];
  const reference = group?.images[0];

  let text = assembled.shotInstruction ?? assembled.instruction;

  if (group) {
    // The resolved tag first, so "@img1-inspired" becomes
    // "the reference image-inspired" rather than being caught by the slug pass
    // below and left as "img1-inspired". \b works because "-" is a non-word
    // character, so the tag still matches at the head of a longer token.
    const tag = group.tag.replace(/^@/, "");
    text = text.replace(new RegExp(`@${escapeRe(tag)}\\b`, "gi"), REFERENCE_PHRASE);
  }

  // Any @imgN still standing refers to an upload that is not attached. With one
  // reference in play there is nothing else it can mean, so it resolves to the
  // same phrase; with none, it is a request that cannot be honoured and saying
  // so costs nothing, where rendering it costs a real generation.
  //
  // Both regexes are cloned, never used directly: they are module-level and /g,
  // so match/replace/test would leave `lastIndex` advanced for every other
  // caller in the process. mentions.ts clones them for the same reason.
  const leftoverImgTags = text.match(new RegExp(MENTION_REGEX)) ?? [];
  if (leftoverImgTags.length) {
    if (!reference) {
      throw new Error(
        `This prompt tags ${[...new Set(leftoverImgTags)].join(", ")} but no ` +
          `reference image is attached. Attach the image, or remove the tag ` +
          `from the prompt.`
      );
    }
    text = text.replace(new RegExp(MENTION_REGEX), REFERENCE_PHRASE);
  }

  // Remaining @slugs named an asset that did not resolve to any image. They are
  // ordinary words to Kling — a name, usually — so strip the app's "@" syntax
  // and leave every word the user wrote. Inventing a referent for them would be
  // worse than saying nothing.
  text = text.replace(new RegExp(TAG_REGEX), (_m, slug: string) => slug);

  // The role rule replaces the group header Kling has no place for — but ONLY
  // when shot-spec is off. shotInstruction opens with its own REFERENCES legend
  // that already binds the image AND states its role, so prepending this as
  // well both duplicates the binding and can contradict it: measured on
  // 2026-07-31 with PROMPT_SHOT_SPEC=1, the legend correctly read "the exact
  // visual style/grade to match" while this header was asserting "reproduce
  // exactly what this shows — same shapes, colours, materials". The legend is
  // role-aware and this is not, so the legend wins where both exist.
  if (group && !assembled.shotInstruction) {
    const rule = group.identity ? PERSON_RULE : SUBJECT_RULE;
    text = `REFERENCE IMAGE — ${rule}.\n\n${text}`;
  }

  return { prompt: text, reference };
}
