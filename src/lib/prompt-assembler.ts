/**
 * Context engineering for asset consistency (server-only).
 *
 * Turns a raw user prompt + the assets/uploads it references into a structured,
 * role-labeled payload: a text instruction that lists every locked asset and
 * keeps the SCENE literal, plus per-asset GROUPS of reference images. Grouping
 * several images under one tag (e.g. 4 angles of a face) and binding each group
 * to its @tag is what actually holds identity across generations.
 */

import { readImageAsBase64 } from "./save-media";
import { identityCrops, prepReference } from "./middleware/image-prep";
import { parseAssetSlugs, parseMentionIndices } from "./mentions";
import type { Asset, AssetKind } from "./types";

export interface AssembledImage {
  mimeType: string;
  data: string; // base64 (no data: prefix)
}

export interface AssembledGroup {
  tag: string; // "@priya" | "@img1"
  /** Header shown right before this group's images, binding them to the tag. */
  header: string;
  images: AssembledImage[];
  /** True when this group is identity ground truth for a person (character
   *  asset, SUBJECT uploads, or a person-classified @imgN upload). */
  identity?: boolean;
  /** Identity tiles: face/sheet-panel crops of this group's images, sent as
   *  EXTRA images (Gemini ingests every image as one flat ~258-token tile, so
   *  a wide character sheet carries almost no facial detail on its own).
   *  Kept separate from `images` so providers can budget them — user images
   *  are never dropped to make room for tiles. */
  tiles?: AssembledImage[];
}

export interface AssembledPrompt {
  /** Full structured text for the first user content part. */
  instruction: string;
  /** Reference-image groups, in the order they should be sent. */
  groups: AssembledGroup[];
  /** Best available face crop for judging generated frames (best-of-N). */
  judgeFace?: AssembledImage;
}

const KIND_LABEL: Record<AssetKind, string> = {
  character: "CHARACTER",
  outfit: "OUTFIT",
  location: "LOCATION",
  style: "STYLE",
  prop: "PROP",
};

const KIND_RULE: Record<AssetKind, string> = {
  character:
    "reproduce this exact person with photographic fidelity — identical face shape and bone structure, jawline, cheekbones, hairline, eye shape/size/spacing and color, eyebrows, nose, lips, ears, skin tone and texture (keep moles, scars, freckles, wrinkles), facial hair, hairstyle, body build and apparent age; unmistakably the SAME individual, never a lookalike, and never beautified, slimmed, de-aged or idealized",
  outfit:
    "reproduce this exact outfit — same garments, cut, fit, fabric, colors, patterns, trims and details, plus any jewelry/accessories shown with it",
  location:
    "reproduce this exact place — same architecture, layout, materials, signage, furnishing and mood",
  style:
    "match this exact visual style — same rendering, palette, grain and lighting treatment",
  prop: "reproduce this exact object — same shape, colors, materials, markings and wear",
};

async function readAll(refs: string[]): Promise<AssembledImage[]> {
  const out: AssembledImage[] = [];
  for (const ref of refs) {
    try {
      const { mimeType, data } = await readImageAsBase64(ref);
      // Middleware: cap oversized refs (Higgsfield-style resize preprocessing).
      out.push(await prepReference(mimeType, data));
    } catch {
      /* skip unreadable image */
    }
  }
  return out;
}

/**
 * Identity tiling: crop the face (and character-sheet panels) into their OWN
 * images, multiplying an identity ref's visual bandwidth 3–4×. Detection
 * gates non-person refs (locations, sets) so no wrong face is injected.
 * Fail-open: [] when nothing is found (or FACE_CROP_MIDDLEWARE=0).
 */
async function faceCrops(
  images: AssembledImage[],
  tag: string,
  limit = 2
): Promise<AssembledImage[]> {
  const out: AssembledImage[] = [];
  for (const img of images.slice(0, limit)) {
    if (out.length >= 3) break;
    out.push(...(await identityCrops(img.mimeType, img.data, 3 - out.length)));
  }
  console.log(
    `[middleware] ${tag}: identity tile${out.length === 1 ? "" : "s"} ${
      out.length ? `added (${out.length})` : "none (not a person ref / no face)"
    }`
  );
  return out;
}

/**
 * Build the assembled payload.
 * @param prompt  raw user prompt (kept literal in the SCENE block)
 * @param assets  all known assets (referenced ones are matched by @slug)
 * @param uploads ad-hoc data-URL uploads, 1-based for @imgN
 */
export async function assemblePrompt(
  prompt: string,
  assets: Asset[],
  uploads: string[]
): Promise<AssembledPrompt> {
  const groups: AssembledGroup[] = [];
  const assetLines: string[] = [];

  // 1) Named asset references (@slug) — only those actually mentioned.
  const slugs = parseAssetSlugs(prompt);
  const bySlug = new Map(assets.map((a) => [a.slug, a]));
  for (const slug of slugs) {
    const asset = bySlug.get(slug);
    if (!asset || !asset.images.length) continue;
    const images = await readAll(asset.images);
    if (!images.length) continue;
    const label = KIND_LABEL[asset.kind];
    const desc = asset.description ? ` — ${asset.description}` : "";
    assetLines.push(
      `- @${asset.slug} → ${label} "${asset.name}"${desc}. Rule: ${KIND_RULE[asset.kind]}.`
    );
    const isCharacter = asset.kind === "character";
    groups.push({
      tag: `@${asset.slug}`,
      header:
        `@${asset.slug} — ${label} "${asset.name}" ` +
        `(${images.length} reference image${images.length > 1 ? "s" : ""}; ` +
        `${KIND_RULE[asset.kind]}):`,
      images,
      identity: isCharacter,
      tiles: isCharacter ? await faceCrops(images, `@${asset.slug}`) : undefined,
    });
  }

  // 2) Ad-hoc uploads.
  //  - If the prompt tags images distinctly (@img1, @img2 …) the user is
  //    pointing at DIFFERENT subjects → keep each separate.
  //  - Otherwise (the common case: a few photos of ONE person, no tags) treat
  //    ALL uploads as multiple angles of the SAME person, so identity locks
  //    instead of the model reading them as different people.
  let hasIdentityRef = false;
  if (uploads.length) {
    const tagged = parseMentionIndices(prompt).filter((n) => n <= uploads.length);
    if (tagged.length > 1) {
      for (const n of tagged) {
        const images = await readAll([uploads[n - 1]]);
        if (!images.length) continue;
        hasIdentityRef = true;
        assetLines.push(
          `- @img${n} → REFERENCE. Rule: reproduce the tagged subject from this ` +
            `image exactly — if it is a person, the identical face (bone ` +
            `structure, eyes, nose, lips, skin tone/texture, marks, hairline, ` +
            `facial hair, apparent age), hairstyle, build and visible ` +
            `outfit/jewelry, changed only where the SCENE explicitly says so. ` +
            `Never blend @img${n} with any other reference.`
        );
        // Person detection decides identity: a face/sheet upload gets tiles;
        // outfit/location/style uploads yield none and stay non-identity.
        const tiles = await faceCrops(images, `@img${n}`, 1);
        groups.push({
          tag: `@img${n}`,
          header:
            `@img${n} — REFERENCE (reproduce this subject exactly; if a person, ` +
            `the same individual — identical facial features, never a lookalike):`,
          images,
          identity: tiles.length > 0,
          tiles: tiles.length ? tiles : undefined,
        });
      }
    } else {
      const images = await readAll(uploads);
      if (images.length) {
        hasIdentityRef = true;
        const many = images.length > 1;
        assetLines.push(
          `- SUBJECT → the person in the reference photo${many ? "s" : ""} below. ` +
            `Rule: the main subject in the output MUST be this exact same person — ` +
            `identical face, hairstyle, build and visible outfit/jewelry unless ` +
            `the SCENE explicitly changes them.`
        );
        const tiles = await faceCrops(images, "SUBJECT");
        groups.push({
          tag: "SUBJECT",
          tiles: tiles.length ? tiles : undefined,
          header: many
            ? `SUBJECT — ${images.length} reference photos of the SAME person ` +
              `(different angles/lighting). Reconstruct ONE consistent identity ` +
              `from all of them; the generated person's face MUST match exactly — ` +
              `same bone structure, jawline, hairline, eye shape/spacing and color, ` +
              `eyebrows, nose, lips, skin tone/texture (keep moles, scars, ` +
              `freckles), facial hair and apparent age. Keep their hairstyle, ` +
              `build and worn outfit/jewelry unless the SCENE explicitly changes ` +
              `them. A recognizable match, never a lookalike — never beautified ` +
              `or idealized:`
            : `SUBJECT — reference photo of the person. The generated person's face ` +
              `MUST be this exact same individual — same bone structure, jawline, ` +
              `hairline, eye shape/spacing and color, eyebrows, nose, lips, skin ` +
              `tone/texture (keep moles, scars, freckles), facial hair and ` +
              `apparent age. Keep their hairstyle, build and worn outfit/jewelry ` +
              `unless the SCENE explicitly changes them. A recognizable match, ` +
              `not a lookalike — never beautified or idealized:`,
          images,
          identity: true,
        });
      }
    }
  }

  // 3) The instruction stays the RAW prompt. Wrapping it in big instruction
  // blocks gets rendered literally (the model drew a movie camera on set);
  // reference binding lives in the group headers instead.
  // judgeFace: identityCrops returns the face close-up first when one exists —
  // the best ground truth for scoring generated frames (best-of-N).
  const judgeFace = groups.find((g) => g.identity && g.tiles?.length)?.tiles?.[0];
  return { instruction: prompt, groups, judgeFace };
}
