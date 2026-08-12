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
import {
  analyzeIdentityReference,
  detectReferenceRole,
  prepReference,
} from "./middleware/image-prep";
import { parseAssetSlugs, parseMentionIndices } from "./mentions";
import {
  buildReferenceLegend,
  buildShotInstruction,
  hasExplicitRefRole,
  hasVisiblePeople,

  parseRefRoles,
  roleHeader,

} from "./shot-spec";

const KIND_LABEL = {
  character: "CHARACTER",
  outfit: "OUTFIT",
  location: "LOCATION",
  style: "STYLE",
  prop: "PROP",
};

/** Maps a named-asset kind onto the shot-spec RefRole vocabulary. */
const ASSET_KIND_TO_ROLE = {
  character: "person",
  outfit: "outfit",
  location: "location",
  style: "style",
  prop: "prop",
};

const KIND_RULE = {
  // Kept character-for-character in sync with ROLE_RULE.person in shot-spec.ts
  // (that module duplicates rather than imports, deliberately — see its header).
  // Identity anchors are the measured wording, untouched; only the three
  // photoreal assumptions were relaxed on 2026-07-28 so a stylized reference is
  // no longer told to add realism it does not have.
  character:
    "reproduce this exact person with exact fidelity to the reference, in the SAME medium and rendering style as the reference (photographic, illustrated, anime, cel-shaded, 3D, painterly or otherwise — never convert it to a different medium, and never add realism the reference does not have) — identical face shape and bone structure, jawline, cheekbones, hairline, eye shape/size/spacing and color, eyebrows, nose, lips, ears, facial hair, hairstyle, body build and apparent age, plus the same distinguishing marks the reference shows; where the reference is photographic, also keep real skin tone and texture (moles, scars, freckles, wrinkles); unmistakably the SAME individual, never a lookalike, and never beautified, slimmed, de-aged or idealized relative to the reference",
  outfit:
    "reproduce this exact outfit — same garments, cut, fit, fabric, colors, patterns, trims and details, plus any jewelry/accessories shown with it",
  location:
    "reproduce this exact place — same architecture, layout, materials, signage, furnishing and mood",
  style:
    "match this exact visual style — same rendering, palette, grain and lighting treatment",
  prop: "reproduce this exact object — same shape, colors, materials, markings and wear",
};

async function readAll(refs) {
  const out = [];
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
  images,
  tag,
  limit = 2
) {
  return (await analyzeFaceCrops(images, tag, limit)).tiles;
}

/** Run the existing identity detector once per considered image and retain
 *  both outputs: exact crop tiles for face fidelity and its tri-state person
 *  signal for safe reference routing. */
async function analyzeFaceCrops(
  images,
  tag,
  limit = 2
) {
  const out = [];
  let sawPerson = false;
  let sawNonPerson = false;
  let sawUnknown = false;
  for (const img of images.slice(0, limit)) {
    if (out.length >= 3) break;
    const analysis = await analyzeIdentityReference(
      img.mimeType,
      img.data,
      3 - out.length
    );
    out.push(...analysis.crops);
    if (analysis.personReference === true) sawPerson = true;
    else if (analysis.personReference === false) sawNonPerson = true;
    else sawUnknown = true;
  }
  console.log(
    `[middleware] ${tag}: identity tile${out.length === 1 ? "" : "s"} ${
      out.length ? `added (${out.length})` : "none (not a person ref / no face)"
    }`
  );
  return {
    tiles: out,
    personReference: sawPerson
      ? true
      : sawUnknown
        ? null
        : sawNonPerson
          ? false
          : null,
  };
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
  tag,
  firstImage,
  tiles,
  textRoles,
  roleDetectOn
) {
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
  prompt,
  assets,
  uploads,
  opts
) {
  const groups = [];
  const assetLines = [];

  // Shot-spec mode (PROMPT_SHOT_SPEC=1): role-aware headers + a reference
  // legend + a structured shotInstruction. Off = untouched, byte-identical.
  const shotSpecOn = process.env.PROMPT_SHOT_SPEC === "1";
  const roleDetectOn = process.env.PROMPT_ROLE_DETECT === "1";
  const textRoles = shotSpecOn ? parseRefRoles(prompt) : new Map();
  const legendEntries = [];

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
  //    instead of the model reading them as different people. A confident
  //    visual non-person classification can opt an untagged location/object
  //    out; uncertainty always preserves the legacy person assumption.
  if (uploads.length) {
    const tagged = parseMentionIndices(prompt).filter((n) => n <= uploads.length);

    // Keep the proven untagged/single-person payload exactly as it was. A
    // singleton @imgN that resolves to a person is deliberately funneled back
    // through this helper, preserving SUBJECT naming, identity tiles, headers,
    // judgeFace eligibility and Gemini's final identity check.
    const pushLegacySubject = async (
      images,
      preparedTiles
    ) => {
      if (!images.length) return;
      const many = images.length > 1;
      assetLines.push(
        `- SUBJECT → the person in the reference image${many ? "s" : ""} below. ` +
          `Rule: the main subject in the output MUST be this exact same person — ` +
          `identical face, hairstyle, build and visible outfit/jewelry unless ` +
          `the SCENE explicitly changes them, rendered in the same medium and ` +
          `style as the reference.`
      );
      const tiles = preparedTiles ?? (await faceCrops(images, "SUBJECT"));
      // "reference photo" presumed the medium in the noun itself; "image" is
      // neutral. The skin-texture clause is now self-conditional and
      // "idealized" is anchored to the reference, so a stylized subject is not
      // pushed toward realism it never had. Every identity anchor from the
      // measured wording is retained.
      let header = many
        ? `SUBJECT — ${images.length} reference images of the SAME person ` +
          `(different angles/lighting). Reconstruct ONE consistent identity ` +
          `from all of them; the generated person's face MUST match exactly — ` +
          `same bone structure, jawline, hairline, eye shape/spacing and color, ` +
          `eyebrows, nose, lips, facial hair and apparent age, and where the ` +
          `references are photographic also their skin tone/texture (keep ` +
          `moles, scars, freckles). Keep their hairstyle, ` +
          `build and worn outfit/jewelry unless the SCENE explicitly changes ` +
          `them, and render in the same medium and style as the references. ` +
          `A recognizable match, never a lookalike — never beautified ` +
          `or idealized relative to the references:`
        : `SUBJECT — reference image of the person. The generated person's face ` +
          `MUST be this exact same individual — same bone structure, jawline, ` +
          `hairline, eye shape/spacing and color, eyebrows, nose, lips, facial ` +
          `hair and apparent age, and where the reference is photographic also ` +
          `their skin tone/texture (keep moles, scars, freckles). ` +
          `Keep their hairstyle, build and worn outfit/jewelry ` +
          `unless the SCENE explicitly changes them, and render in the same ` +
          `medium and style as the reference. A recognizable match, ` +
          `not a lookalike — never beautified or idealized relative to the reference:`;
      if (shotSpecOn) {
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
    };

    const pushNonPersonGroup = (
      tag,
      role,
      images
    ) => {
      assetLines.push(`- ${tag} → ${role.toUpperCase()} REFERENCE.`);
      const header = roleHeader(tag, role, images.length);
      legendEntries.push({ tag, role, isPerson: false });
      groups.push({ tag, header, images, identity: false });
    };

    if (tagged.length > 1) {
      for (const n of tagged) {
        const images = await readAll([uploads[n - 1]]);
        if (!images.length) continue;
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
        let identity = tiles.length > 0;
        if (shotSpecOn) {
          // A positive primary-face analysis is stronger evidence than a
          // nearby scene keyword (e.g. `@img1 looking down in a school`). This
          // protects face refs from the intentionally broad location lexicon.
          const role = tiles.length
            ? "person"
            : await resolveUploadRole(tag, images[0], tiles, textRoles, roleDetectOn);
          header = roleHeader(tag, role, images.length);
          legendEntries.push({ tag, role, isPerson: role === "person" });
          // A positive primary-face analysis or explicit person role keeps
          // its identity contract; non-person roles stay out of FINAL CHECK.
          identity = role === "person";
        }
        groups.push({
          tag,
          header,
          images,
          identity,
          tiles: identity && tiles.length ? tiles : undefined,
        });
      }
    } else if (tagged.length === 1 && shotSpecOn) {
      // A single explicit tag is NOT the same thing as an untagged person
      // upload. Resolve it first so `empty school from @img1` cannot become a
      // forced FACE/IDENTITY reference. This was the main location-ref bug.
      const n = tagged[0];
      const tag = `@img${n}`;
      const images = await readAll([uploads[n - 1]]);
      if (images.length) {
        const textRole = textRoles.get(tag);
        // Always retain the existing face analysis for a singleton. A broad
        // scene keyword near @img1 must never downgrade a real face reference.
        const tiles = await faceCrops(images, tag, 1);
        const explicitTextRole =
          textRole !== undefined && hasExplicitRefRole(prompt, tag, textRole);
        let detectedRole = null;
        if (
          textRole !== "person" &&
          tiles.length === 0 &&
          !explicitTextRole
        ) {
          // `tiles.length === 0` is ambiguous: it can mean a non-person image,
          // a detector failure, OR an extreme close-up that intentionally did
          // not need another crop. Resolve that ambiguity visually. Unknown
          // still falls back to the legacy person assumption below.
          detectedRole = await detectReferenceRole(images[0].mimeType, images[0].data);
          if (textRole && detectedRole && detectedRole !== textRole) {
            console.log(
              `[shot-spec] WARN role mismatch for ${tag}: prompt text says ` +
                `"${textRole}", detection says "${detectedRole}".`
            );
          }
        }
        const role =
          textRole === "person" || tiles.length > 0
            ? "person"
            : explicitTextRole
              ? textRole
              : detectedRole ?? "person";

        if (role === "person") {
          if (uploads.length === 1) {
            await pushLegacySubject(images, tiles);
          } else {
            // Preserve the prior multi-angle convention: one person tag plus
            // additional untagged uploads means multiple views of that person.
            await pushLegacySubject(await readAll(uploads));
          }
        } else {
          pushNonPersonGroup(tag, role, images);
        }
      }
    } else {
      const images = await readAll(uploads);
      if (!shotSpecOn || !images.length) {
        await pushLegacySubject(images);
      } else {
        // Untagged uploads historically mean one person's reference angles.
        // Preserve that on any human cue, found face, person classification,
        // or detector uncertainty. Only a confident visual non-person result
        // may opt a location/object/style ref out of the identity pipeline.
        const tiles = await faceCrops(images, "SUBJECT");
        if (hasVisiblePeople(prompt) || tiles.length > 0) {
          await pushLegacySubject(images, tiles);
        } else {
          const detectedRole = await detectReferenceRole(
            images[0].mimeType,
            images[0].data
          );
          if (detectedRole && detectedRole !== "person") {
            pushNonPersonGroup("REFERENCE", detectedRole, images);
          } else {
            await pushLegacySubject(images, tiles);
          }
        }
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
  let shotInstruction;
  if (shotSpecOn) {
    const legend = buildReferenceLegend(legendEntries);
    shotInstruction = buildShotInstruction({
      rawPrompt: prompt,
      legend,
      aspectRatio: opts?.aspectRatio || "1:1",
      medium: opts?.medium,
      hasPersonReference: legendEntries.some((entry) => entry.isPerson),
    });
  }

  return { instruction: prompt, shotInstruction, groups, judgeFace };
}
