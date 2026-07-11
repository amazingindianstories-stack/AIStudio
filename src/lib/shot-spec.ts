/**
 * Deterministic shot-spec text assembly (pure, server-safe, no API calls).
 *
 * Everything here is templated/auditable — never an LLM rewrite of the user's
 * prompt. The 2026-07 movie-camera incident proved meta-instruction text gets
 * rendered literally, and the higgsfield-nbp-parity research showed the whole
 * win over Higgsfield's shape is structural (role legend + role-labeled
 * headers + wide-AR framing language + an in-prompt negative block), which a
 * template captures fully without the paraphrase/latency/drift risk of an LLM
 * pass. Consumed by prompt-assembler.ts only when PROMPT_SHOT_SPEC=1.
 */

export type RefRole =
  | "person"
  | "outfit"
  | "location"
  | "style"
  | "prop"
  | "object";

export interface LegendEntry {
  tag: string; // "@img1" | "@priya" | "SUBJECT"
  role: RefRole;
  isPerson: boolean; // drives identity language in the legend line
}

export type ImageSubjectMode = "person" | "environment";

// Reproduction-rule wording per role. Person/outfit/location/style/prop
// wording mirrors the KIND_RULE strings proven in prompt-assembler.ts
// (duplicated, not imported — this module must stay import-free of
// server-only code). "object" is new: the generic non-person, non-asset-kind
// fallback for an @imgN upload whose role couldn't be inferred.
const ROLE_RULE: Record<RefRole, string> = {
  person:
    "reproduce this exact person with photographic fidelity — identical face shape and bone structure, jawline, cheekbones, hairline, eye shape/size/spacing and color, eyebrows, nose, lips, ears, skin tone and texture (keep moles, scars, freckles, wrinkles), facial hair, hairstyle, body build and apparent age; unmistakably the SAME individual, never a lookalike, and never beautified, slimmed, de-aged or idealized",
  outfit:
    "reproduce this exact outfit — same garments, cut, fit, fabric, colors, patterns, trims and details, plus any jewelry/accessories shown with it",
  location:
    "reproduce this exact place — same architecture, layout, materials, signage, furnishing and mood",
  style:
    "match this exact visual style — same rendering, palette, grain and lighting treatment",
  prop: "reproduce this exact object — same shape, colors, materials, markings and wear",
  object:
    "reproduce this exact object/element as shown — same shape, colors, materials and details, used exactly as the SCENE directs",
};

/** The reproduction rule sentence for a role (reuses the KIND_RULE wording
 *  already proven in prompt-assembler.ts for character/outfit/location/style/prop). */
export function roleRule(role: RefRole): string {
  return ROLE_RULE[role];
}

const ROLE_LABEL: Record<RefRole, string> = {
  person: "FACE/IDENTITY",
  outfit: "OUTFIT",
  location: "LOCATION",
  style: "STYLE",
  prop: "PROP",
  object: "OBJECT",
};

/** Role-aware group header (replaces the generic "@imgN — REFERENCE (reproduce
 *  this subject exactly; if a person…)" for uploads). Example person header:
 *  "@img1 — FACE/IDENTITY reference (N images): reproduce this exact individual …". */
export function roleHeader(tag: string, role: RefRole, imageCount: number): string {
  const plural = imageCount === 1 ? "image" : "images";
  return `${tag} — ${ROLE_LABEL[role]} reference (${imageCount} ${plural}): ${roleRule(role)}.`;
}

// Keyword groups scanned within a word window around each @tag mention.
// Checked in this order; the first group with a hit inside the window wins.
const ROLE_KEYWORDS: Array<{ role: RefRole; re: RegExp }> = [
  {
    role: "outfit",
    re: /\b(outfit|dress|garment|wearing|lehenga|saree|sari|suit|gown|jacket|attire|clothing|clothes|costume)\b/i,
  },
  {
    role: "location",
    re: /\b(location|nightclub|club|place|background|room|set|environment|venue|backdrop|scene|school|classroom|campus|corridor|hallway|building|interior|exterior|architecture|house|home|office|street|road|landscape)\b/i,
  },
  {
    role: "style",
    re: /\b(style|aesthetic|grade|palette|mood|tone|filter)\b/i,
  },
  {
    role: "person",
    re: /\b(face|identity|person|character|portrait|likeness|subject|individual)\b/i,
  },
];

// Matches a bare @tag token at the start of a whitespace-split word (a token
// may carry trailing punctuation, e.g. "@img3(image_3),").
const TAG_TOKEN = /@([a-z][a-z0-9_-]*)/i;

/** Deterministic role inference from prompt prose. For each @imgN / @slug tag
 *  occurrence, scan a small word window around the mention for role keywords
 *  (outfit|dress|garment|wearing|lehenga|saree|suit…; location|nightclub|club|
 *  place|background|room|set|environment…; style|aesthetic|grade|palette…;
 *  face|identity|person|character|portrait|likeness…). First match wins.
 *  Tags with no inferable role are OMITTED from the map (caller falls back).
 *  Pure; no API. Case-insensitive. */
export function parseRefRoles(prompt: string): Map<string, RefRole> {
  const map = new Map<string, RefRole>();
  const tokens = prompt.split(/\s+/).filter(Boolean);
  const WINDOW = 6; // words on each side of the mention

  for (let i = 0; i < tokens.length; i++) {
    const m = tokens[i].match(TAG_TOKEN);
    if (!m) continue;
    const tag = `@${m[1].toLowerCase()}`;
    if (map.has(tag)) continue; // first occurrence WITH a match already won

    const start = Math.max(0, i - WINDOW);
    const end = Math.min(tokens.length, i + WINDOW + 1);
    const windowText = tokens.slice(start, end).join(" ");
    for (const { role, re } of ROLE_KEYWORDS) {
      if (re.test(windowText)) {
        map.set(tag, role);
        break;
      }
    }
  }
  return map;
}

/** Best deterministic non-person role for an untagged reference after visual
 *  analysis has already ruled out a person. Falls back to generic object. */
export function inferNonPersonRole(
  prompt: string
): Exclude<RefRole, "person"> {
  for (const { role, re } of ROLE_KEYWORDS) {
    if (role !== "person" && re.test(prompt)) return role;
  }
  return "object";
}

const EXPLICIT_ROLE_TERMS: Record<RefRole, string> = {
  person: "face|identity|person|character|portrait|likeness|subject|individual",
  outfit:
    "outfit|dress|garment|lehenga|saree|sari|suit|gown|jacket|attire|clothing|clothes|costume",
  location:
    "location|nightclub|club|place|background|room|set|environment|venue|backdrop|school|classroom|campus|corridor|hallway|building|interior|exterior|architecture|house|home|office|street|road|landscape",
  style: "style|aesthetic|grade|palette|mood|tone|filter",
  prop: "prop|object|item",
  object: "object|element|item",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True only when prompt grammar binds a role directly to a tag, rather than
 * merely mentioning a scene keyword inside parseRefRoles' broad context
 * window. Examples: "@img1 as the exact location", "school from @img1",
 * "face from @img1". This confidence bit lets singleton routing trust a clear
 * non-person instruction while failing safely to the legacy face path when a
 * detector is unavailable and the prose is ambiguous.
 */
export function hasExplicitRefRole(
  prompt: string,
  tag: string,
  role: RefRole
): boolean {
  const escapedTag = escapeRegExp(tag);
  const terms = EXPLICIT_ROLE_TERMS[role];
  const tagThenRole = new RegExp(
    `${escapedTag}(?:\\([^)]*\\))?\\s+(?:as|for|is|defines?|shows?)\\s+` +
      `(?:the\\s+)?(?:exact\\s+)?(?:${terms})\\b`,
    "i"
  );
  const roleThenTag = new RegExp(
    `\\b(?:${terms})\\b\\s+(?:reference\\s+)?(?:from|using|of|at|in)\\s+` +
      `${escapedTag}(?:\\([^)]*\\))?`,
    "i"
  );
  return tagThenRole.test(prompt) || roleThenTag.test(prompt);
}

function legendLine(entry: LegendEntry): string {
  if (entry.isPerson) {
    return `${entry.tag} = the exact face/identity of the subject — must be reproduced with photographic fidelity, never a lookalike.`;
  }
  switch (entry.role) {
    case "outfit":
      return `${entry.tag} = the exact outfit worn by the subject.`;
    case "location":
      return `${entry.tag} = the exact location/setting of the scene.`;
    case "style":
      return `${entry.tag} = the exact visual style/grade to match.`;
    case "prop":
      return `${entry.tag} = the exact prop/object to reproduce.`;
    case "object":
      return `${entry.tag} = the exact object/element to reproduce.`;
    default:
      return `${entry.tag} = a reference to reproduce exactly.`;
  }
}

/** "REFERENCES:\n@img1 = the exact face/identity of the subject …\n@img2 = …"
 *  Returns null for an empty list. */
export function buildReferenceLegend(entries: LegendEntry[]): string | null {
  if (!entries.length) return null;
  return "REFERENCES:\n" + entries.map(legendLine).join("\n");
}

// Human nouns inside an explicit absence clause must not turn an empty scene
// back into a people scene ("no students or staff", "without any people").
// Strip those clauses before scanning for positive cast intent.
const HUMAN_NOUN_SOURCE =
  "people|persons?|humans?|men|women|man|woman|boys?|girls?|children|child|" +
  "bab(?:y|ies)|adults?|students?|pupils?|teachers?|staff|workers?|employees?|" +
  "guards?|officers?|doctors?|nurses?|patients?|customers?|shoppers?|" +
  "passengers?|drivers?|pedestrians?|visitors?|tourists?|guests?|residents?|" +
  "farmers?|vendors?|waiters?|waitresses?|chefs?|soldiers?|actors?|actresses?|" +
  "dancers?|singers?|musicians?|athletes?|players?|artists?|photographers?|" +
  "pilots?|attendants?|bartenders?|cashiers?|monks?|priests?|friends?|parents?|" +
  "mothers?|fathers?|moms?|dads?|brothers?|sisters?|husbands?|wives|wife|" +
  "partners?|owners?|leaders?|members?|teenagers?|teens?|youths?|protagonists?|" +
  "characters?";

const NEGATED_HUMANS_RE = new RegExp(
  `\\b(?:no|without)\\s+(?:(?:any|a|an|visible|additional|other)\\s+)?` +
    `(?:${HUMAN_NOUN_SOURCE})` +
    `(?:\\s*(?:,|and|or)\\s*(?:${HUMAN_NOUN_SOURCE}))*\\b`,
  "gi"
);

// Possessive/label compounds describe furniture or zones, not visible cast:
// "teacher's desk", "student lockers", "staff room", etc.
const HUMAN_LABELLED_OBJECT_RE = new RegExp(
  `\\b(?:students?|pupils?|teachers?|staff|workers?|employees?|visitors?|` +
    `passengers?|drivers?|children|child)(?:['’]s?|s['’])?\\s+` +
    `(?:desks?|chairs?|tables?|areas?|lounges?|rooms?|sections?|entrances?|` +
    `exits?|lockers?|uniforms?|signs?|zones?)\\b`,
  "gi"
);

const POSITIVE_HUMAN_NOUN_RE = new RegExp(
  `\\b(?:${HUMAN_NOUN_SOURCE}|crowd|audience|couple|family|families|bride|` +
    `groom|hero|heroine|subject|individual|portrait|selfie|face|identity|` +
    `male|female|elderly|eyes?|hands?|arms?|legs?|head|body|bodies|skin|hair)\\b`,
  "i"
);

const HUMAN_PRONOUN_RE =
  /\b(?:he|she|him|her|his|hers|they|them|their|theirs|someone|somebody)\b/i;

// These verbs imply an animate subject even when the prompt omits a noun
// ("standing at the window"). Deliberately exclude bare looking/facing: in
// location prompts those commonly describe the camera, which is the bug this
// policy is meant to prevent.
const HUMAN_ACTION_RE =
  /\b(?:stands?|standing|sits?|sitting|seated|walks?|walking|runs?|running|poses?|posing|wears?|wearing|dressed|holds?|holding|smiles?|smiling|laughs?|laughing|cries|crying|speaks?|speaking|talks?|talking|kneels?|kneeling|dances?|dancing|sings?|singing|gestures?|gesturing)\b/i;

// Preserve a named character action such as "Naisha looking down" while
// leaving "camera looking down" and "view looking up" as viewpoint language.
const NAMED_LOOK_RE =
  /\b(?!Camera\b|View\b|Viewpoint\b|Shot\b|Lens\b|Angle\b|Perspective\b)[A-Z][a-z][A-Za-z'-]*\s+(?:is\s+)?(?:looking|facing|gazing)\b/;

/**
 * Whether the scene explicitly asks for a physically present person/cast.
 * A person/character reference is authoritative. Otherwise this stays
 * conservative and deterministic: positive nouns/pronouns/actions opt into
 * the proven person prompt path; absent cast intent opts into zero-cast
 * safeguards. The raw prompt is never rewritten.
 */
export function hasVisiblePeople(
  rawPrompt: string,
  hasPersonReference = false
): boolean {
  if (hasPersonReference) return true;
  const positiveText = rawPrompt
    .replace(NEGATED_HUMANS_RE, " ")
    .replace(HUMAN_LABELLED_OBJECT_RE, " ");
  return (
    POSITIVE_HUMAN_NOUN_RE.test(positiveText) ||
    HUMAN_PRONOUN_RE.test(positiveText) ||
    HUMAN_ACTION_RE.test(positiveText) ||
    NAMED_LOOK_RE.test(positiveText)
  );
}

const VIEWPOINT_DIRECTION_RE =
  /\b(?:(?:camera|view(?:point)?|shot|angle|perspective|lens)\s+(?:is\s+)?(?:looking|pointing|facing|tilting?)\s+(?:straight\s+)?(?:up|down)|(?:looking|viewed|seen|shot|filmed)\s+(?:straight\s+)?(?:up|down)|(?:from|viewed\s+from)\s+(?:directly\s+)?(?:above|below)|top[- ]down|bottom[- ]up|bird['’]?s[- ]eye|worm['’]?s[- ]eye|overhead|high[- ]angle|low[- ]angle)\b/i;

export const ZERO_CAST_POLICY =
  "CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. " +
  "Do not invent any physically present person, bystander, crowd, camera " +
  "operator, observer, or human silhouette. Any inferred details must be " +
  "non-human and belong to the requested environment.";

export const VIEWPOINT_POLICY =
  'VIEWPOINT: directional phrases such as "looking down" or "looking up" ' +
  "describe the virtual camera/view orientation only; they do not imply an " +
  "observer or on-screen character.";

/** Extra provider text for a no-cast image. Null keeps every person/reference
 *  payload byte-identical to the proven identity path. */
export function buildCastPolicy(
  rawPrompt: string,
  hasPersonReference = false
): string | null {
  if (hasVisiblePeople(rawPrompt, hasPersonReference)) return null;
  return VIEWPOINT_DIRECTION_RE.test(rawPrompt)
    ? `${ZERO_CAST_POLICY}\n${VIEWPOINT_POLICY}`
    : ZERO_CAST_POLICY;
}

/** Wide-AR subject-framing coda. Non-null ONLY for "16:9" and "21:9"; null for
 *  square/portrait ARs. `medium` defaults to "image" (photography language,
 *  byte-identical to the pre-video-support text); "video" swaps in motion/
 *  camera language — subject large and prominent through the WHOLE shot, one
 *  coherent camera move, focal point held across frames — for the Omni video
 *  path (see prompt-assembler.ts opts.medium). */
export function buildFramingCoda(
  aspectRatio: string,
  medium: "image" | "video" = "image",
  subjectMode: ImageSubjectMode = "person"
): string | null {
  if (aspectRatio !== "16:9" && aspectRatio !== "21:9") return null;
  if (medium === "video") {
    return (
      "FRAMING: keep the subject large and prominent through the whole shot — " +
      "a hero composition within the wide field, one coherent camera move, " +
      "the subject remaining the clear focal point across every frame, never " +
      "small or distant; background and environment stay supporting, in sharp " +
      "focus but not competing with the subject for size."
    );
  }
  if (subjectMode === "environment") {
    return (
      "FRAMING: compose only the explicitly requested setting and objects " +
      "across the wide field; do not invent a foreground figure to satisfy " +
      "the composition. Keep architecture and environment detailed, sharp, " +
      "and visually balanced."
    );
  }
  return (
    "FRAMING: keep the subject large and prominent in the frame — a hero " +
    "composition within the wide field, the subject filling roughly half to " +
    "two-thirds of the frame height and placed in the frame's power zone, " +
    "never small or distant; background and environment stay supporting, " +
    "in sharp focus but not competing with the subject for size."
  );
}

/** In-prompt NEGATIVE block, photography-phrased. Constant. */
export const NEGATIVE_CODA =
  "blur or softness on the subject, smeared or plasticky skin, washed-out or " +
  "muddy color cast, loss of background/environment detail, a small or " +
  "distant subject, extra or duplicated limbs, warped anatomy.";

/** Still-image negative block for scenes with no requested cast. It avoids
 *  the skin/limb/anatomy vocabulary that was priming a person into otherwise
 *  empty locations. */
export const ENVIRONMENT_NEGATIVE_CODA =
  "unrequested people, bystanders, crowds or human silhouettes, invented " +
  "foreground figures, blur or softness on the requested focal elements, " +
  "washed-out or muddy color cast, loss of architecture or environment detail.";

/** In-prompt NEGATIVE block for medium "video" — targets temporal artifacts
 *  (identity/wardrobe drift, morphing, flicker) instead of stills-only
 *  framing complaints. Omni has no negative-prompt param, so this in-prompt
 *  block is the only lever and stays for video too. */
export const VIDEO_NEGATIVE_CODA =
  "identity or wardrobe drift between frames, face morphing, flicker, " +
  "duplicated or extra limbs, warped anatomy, a small or distant subject, " +
  "smeared or plasticky skin.";

/** Compose the final structured instruction. rawPrompt is inserted VERBATIM.
 *  Layout:
 *    <legend?>\n\n
 *    SCENE: <rawPrompt>\n\n
 *    <framingCoda?>\n
 *    AVOID: <NEGATIVE_CODA | VIDEO_NEGATIVE_CODA>
 *  buildShotInstruction owns the "SCENE:" prefix so gemini.buildParts (and
 *  omni-input.ts's builder) must not re-add it. `medium` defaults to "image"
 *  — output is byte-identical to before video support; "video" swaps in the
 *  motion-language framing coda and the temporal-artifact AVOID block. */
export function buildShotInstruction(args: {
  rawPrompt: string;
  legend: string | null;
  aspectRatio: string;
  medium?: "image" | "video";
  hasPersonReference?: boolean;
}): string {
  const {
    rawPrompt,
    legend,
    aspectRatio,
    medium = "image",
    hasPersonReference = false,
  } = args;
  // Video keeps its established temporal prompt shape. The zero-cast policy
  // is an image-generation correction and must not perturb Omni/Seedance.
  const subjectMode: ImageSubjectMode =
    medium === "image" && !hasVisiblePeople(rawPrompt, hasPersonReference)
      ? "environment"
      : "person";
  const framingCoda = buildFramingCoda(aspectRatio, medium, subjectMode);

  const blocks: string[] = [];
  if (legend) blocks.push(legend);
  blocks.push(`SCENE: ${rawPrompt}`);

  const tail: string[] = [];
  if (framingCoda) tail.push(framingCoda);
  tail.push(
    `AVOID: ${
      medium === "video"
        ? VIDEO_NEGATIVE_CODA
        : subjectMode === "environment"
          ? ENVIRONMENT_NEGATIVE_CODA
          : NEGATIVE_CODA
    }`
  );
  blocks.push(tail.join("\n"));

  return blocks.join("\n\n");
}
