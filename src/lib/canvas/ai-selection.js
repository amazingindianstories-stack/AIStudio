// The board selection as AI context, read from the data model (never the DOM, so viewport culling does not matter),
// and the one-click AI actions that run on it. Mirrors backend/apps/agents/board.py (`context_text`).

export const MAX_CONTEXT_ITEMS = 60;
export const MAX_CONTEXT_TEXT = 2000;
const TEXT_TYPES = new Set(["sticky", "text", "shape", "rect", "ellipse", "triangle", "diamond"]);
/** Objects whose fill holds their text, so a recolour also sets the text colour that reads on it. */
export const COLORABLE_TYPES = new Set(["sticky", "shape", "rect", "ellipse", "triangle", "diamond"]);

/** The text an object shows: its text, or a frame's name; "" when it has none. */
export function nodeText(node) {
  if (node.type === "frame") return typeof node.name === "string" ? node.name : "";
  return TEXT_TYPES.has(node.type) && typeof node.text === "string" ? node.text : "";
}

/**
 * The selected objects, in board order, as the AI sees them: text-bearing objects, the images among them, and the
 * notes and shapes a recolour reaches (blank ones too).
 */
export function selectionContext(nodes, selectionIds) {
  const wanted = new Set(selectionIds ?? []);
  const selected = (nodes ?? []).filter((node) => wanted.has(node.id));
  const items = [];
  const images = [];
  const colorable = [];
  for (const node of selected) {
    if (node.type === "image" && typeof node.src === "string" && node.src.startsWith("/api/media/")) {
      images.push({ id: node.id, src: node.src, alt: typeof node.alt === "string" ? node.alt : "" });
      continue;
    }
    const text = nodeText(node).trim().slice(0, MAX_CONTEXT_TEXT);
    if (text && items.length < MAX_CONTEXT_ITEMS) items.push({ id: node.id, type: node.type, text });
    if (COLORABLE_TYPES.has(node.type) && colorable.length < MAX_CONTEXT_ITEMS) colorable.push({ id: node.id, type: node.type, text });
  }
  return { items, images, colorable, count: selected.length };
}

export const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch", "Polish", "Russian", "Turkish", "Arabic",
  "Hindi", "Bengali", "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)", "Indonesian",
];
export const TONES = ["Friendly", "Professional", "Business", "Fun"];

/**
 * One-click actions on a selection. Each names the backend format and the prompt it starts with; the person still
 * presses Generate, so nothing paid starts on its own.
 */
export const SELECTION_ACTIONS = [
  { id: "fix", label: "Fix grammar and spelling", format: "rewrite", prompt: "Fix grammar and spelling. Keep the wording otherwise.", needs: "text" },
  { id: "shorten", label: "Shorten", format: "rewrite", prompt: "Shorten each text to its essentials.", needs: "text" },
  { id: "clarify", label: "Rewrite for clarity", format: "rewrite", prompt: "Rewrite each text for clarity.", needs: "text" },
  { id: "keywords", label: "Cluster by keywords", format: "cluster", prompt: "Group the notes by the keywords they share.", needs: "stickies" },
  { id: "sentiment", label: "Cluster by sentiment", format: "cluster", prompt: "Group the notes by sentiment.", needs: "stickies" },
  { id: "summary", label: "Summarize into a note", format: "summary", prompt: "Summarize the selected content.", needs: "text" },
  { id: "notes", label: "Turn into meeting notes", format: "summary", prompt: "Turn the selected content into meeting notes with decisions and next steps.", needs: "text" },
];
export const toneAction = (tone) => ({ id: `tone-${tone}`, format: "rewrite", prompt: `Change the tone of each text to ${tone.toLowerCase()}.`, needs: "text" });
export const translateAction = (language) => ({ id: `translate-${language}`, format: "rewrite", prompt: `Translate each text into ${language}.`, needs: "text" });

/** Recolours the selected notes (and shapes) to one of the board's named colours; the prompt stays editable for any other. */
export const recolorAction = (name) => ({ id: `recolor-${name}`, format: "recolor", prompt: `Change the colour of each selected object to ${name}.`, needs: "colorable" });

const NOUN_REF = String.raw`(?:(?:the|this|that|these|those|each|every|all|all\s+(?:of\s+)?(?:the|these|those))\s+)?(?:selected\s+)?(?:sticky\s+)?(?:notes?|stickies|shapes?|objects?)`;
const PRONOUN_REF = String.raw`(?:them|(?:these|those)(?=\s+(?:to|by)\b|\s*[.!?]?\s*$))`;
const COLOR_NAME = String.raw`(?:yellow|orange|pink|purple|blue|green|red|teal|black|white|gr[ae]y|brown|navy|cyan|magenta|violet|indigo|lime|gold|silver|beige|maroon|olive|crimson|lavender|turquoise|coral|peach|mint|cream|tan|charcoal|amber|mauve|#[0-9a-f]{3}(?:[0-9a-f]{3})?)`;
const SHADE = String.raw`(?:to|in|dark|light|bright|pale|deep|soft)`;
const START = String.raw`^\s*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?`;
const COLOR_END = String.raw`(?:\s+${SHADE})*\s+${COLOR_NAME}(?:\s+please)?\s*[.!?]?\s*$`;
const RECOLOR_REQUESTS = [
  new RegExp(String.raw`${START}(?:make|turn|paint|(?:re-?)?colou?r|change|set)\s+(?:them|these|those|it|this|that|${NOUN_REF})${COLOR_END}`, "i"),
  new RegExp(String.raw`${START}(?:change|switch|set|update)\s+(?:(?:the\s+)?colou?rs?\s+of\s+(?:${PRONOUN_REF}|${NOUN_REF}\b)|(?:their|${NOUN_REF}'?s?)\s+colou?rs?\b|the\s+colou?rs?${COLOR_END})`, "i"),
  new RegExp(String.raw`${START}(?:re-?)?colou?r\s+(?:${PRONOUN_REF}|${NOUN_REF}\b)`, "i"),
];

/** Whether a typed prompt asks to recolour the selection ("make these notes black", "change their colour to #ff00aa"). */
export const isRecolorRequest = (prompt) => RECOLOR_REQUESTS.some((pattern) => pattern.test(prompt ?? ""));

/** Whether `action` has something to work on in `context` (a `selectionContext` result). */
export function actionApplies(action, context, nodes) {
  if (action.needs === "colorable") return context.colorable.length > 0;
  if (!context.items.length) return false;
  if (action.needs !== "stickies") return true;
  const ids = new Set(context.items.map((item) => item.id));
  return (nodes ?? []).some((node) => ids.has(node.id) && node.type === "sticky");
}

/** The request body fields a selection adds to a board AI request (text context, or reference images for an image). */
export function contextFields(format, context) {
  if (format === "image") return context.images.length ? { referenceImages: context.images.slice(0, 4).map((image) => image.src) } : {};
  if (format === "recolor") return context.colorable.length ? { context: context.colorable } : {};
  return context.items.length ? { context: context.items } : {};
}

export const SELECTION_FORMATS = ["rewrite", "recolor", "cluster", "summary"];
