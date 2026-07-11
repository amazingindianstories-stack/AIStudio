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
import { detectReferenceRole, identityCrops, prepReference } from "./middleware/image-prep";
import { parseAssetSlugs, parseMentionIndices } from "./mentions";
import {
  buildReferenceLegend,
  buildShotInstruction,
  parseRefRoles,
  roleHeader,
  type LegendEntry,
  type RefRole,
} from "./shot-spec";
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
  /** Full structured text for the first user content part. Always the raw
   *  prompt — never overwritten, in either mode. */
  instruction: string;
  /** Structured text (role legend + literal SCENE + framing/negative codas),
   *  set only when PROMPT_SHOT_SPEC=1. Already contains its own "SCENE:"
   *  prefix — providers must use this verbatim instead of re-wrapping
   *  `instruction` when present. */
  shotInstruction?: string;
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

/** Maps a named-asset kind onto the shot-spec RefRole vocabulary. */
const ASSET_KIND_TO_ROLE: Record<AssetKind, RefRole> = {
  character: "person",
  outfit: "outfit",
  location: "location",
  style: "style",
  prop: "prop",
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
 * Resolve the RefRole for an @imgN / SUBJECT upload when PROMPT_SHOT_SPEC=1.
 * Precedence: prompt-text keyword scan (parseRefRoles) wins when present — it
 * is the user's explicit binding contract; PROMPT_ROLE_DETECT=1 is consulted
 * as a fallback AND a cross-check (a mismatch is logged, never auto-"fixed",
 * so ref/tag ordering mistakes surface to humans instead of being silently
 * reconciled); otherwise fall back to today's identity signal (tiles found →
 * person, else object). Fail-open: detection errors resolve to null upstream.
 */
async function resolveUploadRole(
  tag: string,
  firstImage: AssembledImage,
  tiles: AssembledImage[],
  textRoles: Map<string, RefRole>,
  roleDetectOn: boolean
): Promise<RefRole> {
  const textRole = textRoles.get(tag);
  if (textRole) {
    if (roleDetectOn) {
      // Cross-check is diagnostic only — don't spend hot-path latency on it
      // (detection is ~3s/ref, sequential); let it resolve during generation.
      void detectReferenceRole(firstImage.mimeType, firstImage.data)
        .then((detected) => {
          if (detected && detected !== textRole) {
            console.log(
              `[shot-spec] WARN role mismatch for ${tag}: prompt text says ` +
                `"${textRole}", detection says "${detected}" — using the prompt-text role.`
            );
          }
        })
        .catch(() => {});
    }
    return textRole;
  }
  const detected = roleDetectOn
    ? await detectReferenceRole(firstImage.mimeType, firstImage.data)
    : null;
  return detected ?? (tiles.length > 0 ? "person" : "object");
}

/**
 * Build the assembled payload.
 * @param prompt  raw user prompt (kept literal in the SCENE block)
 * @param assets  all known assets (referenced ones are matched by @slug)
 * @param uploads ad-hoc data-URL uploads, 1-based for @imgN
 * @param opts    aspectRatio, used only to gate the wide-AR framing coda when
 *                PROMPT_SHOT_SPEC=1; medium ("image" | "video", default
 *                "image") selects the shot-spec's framing/AVOID wording for
 *                the Omni video path. Optional/omitted ⇒ today's behavior.
 */
export async function assemblePrompt(
  prompt: string,
  assets: Asset[],
  uploads: string[],
  opts?: { aspectRatio?: string; medium?: "image" | "video" }
): Promise<AssembledPrompt> {
  const groups: AssembledGroup[] = [];
  const assetLines: string[] = [];

  // Shot-spec mode (PROMPT_SHOT_SPEC=1): role-aware headers + a reference
  // legend + a structured shotInstruction. Off = untouched, byte-identical.
  const shotSpecOn = process.env.PROMPT_SHOT_SPEC === "1";
  const roleDetectOn = process.env.PROMPT_ROLE_DETECT === "1";
  const textRoles = shotSpecOn ? parseRefRoles(prompt) : new Map<string, RefRole>();
  const legendEntries: LegendEntry[] = [];

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
    const tag = `@${asset.slug}`;
    let header =
      `@${asset.slug} — ${label} "${asset.name}" ` +
      `(${images.length} reference image${images.length > 1 ? "s" : ""}; ` +
      `${KIND_RULE[asset.kind]}):`;
    if (shotSpecOn) {
      const role = ASSET_KIND_TO_ROLE[asset.kind];
      header = roleHeader(tag, role, images.length);
      legendEntries.push({ tag, role, isPerson: role === "person" });
    }
    groups.push({
      tag,
      header,
      images,
      identity: isCharacter,
      tiles: isCharacter ? await faceCrops(images, tag) : undefined,
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
        const tag = `@img${n}`;
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
        const tiles = await faceCrops(images, tag, 1);
        let header =
          `${tag} — REFERENCE (reproduce this subject exactly; if a person, ` +
          `the same individual — identical facial features, never a lookalike):`;
        if (shotSpecOn) {
          const role = await resolveUploadRole(tag, images[0], tiles, textRoles, roleDetectOn);
          header = roleHeader(tag, role, images.length);
          legendEntries.push({ tag, role, isPerson: role === "person" });
        }
        groups.push({
          tag,
          header,
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
        let header = many
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
            `not a lookalike — never beautified or idealized:`;
        if (shotSpecOn) {
          // SUBJECT is always the untagged-upload identity ref → role person.
          header = roleHeader("SUBJECT", "person", images.length);
          legendEntries.push({ tag: "SUBJECT", role: "person", isPerson: true });
        }
        groups.push({
          tag: "SUBJECT",
          tiles: tiles.length ? tiles : undefined,
          header,
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

  // shotInstruction: the structured shape (legend + literal SCENE + framing/
  // negative codas) — built only in shot-spec mode, never replacing `prompt`.
  let shotInstruction: string | undefined;
  if (shotSpecOn) {
    const legend = buildReferenceLegend(legendEntries);
    shotInstruction = buildShotInstruction({
      rawPrompt: prompt,
      legend,
      aspectRatio: opts?.aspectRatio || "1:1",
      medium: opts?.medium,
    });
  }

  return { instruction: prompt, shotInstruction, groups, judgeFace };
}
