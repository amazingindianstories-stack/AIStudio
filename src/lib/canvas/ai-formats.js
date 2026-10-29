// Board "Create with AI" formats: what the panel offers and how a finished result becomes board nodes.
// Each entry mirrors a backend format (backend/apps/canvas/ai_jobs.py ENGINES). A later format (Doc, mind map,
// table, Kanban, timeline, slides) adds one entry here with its suggestions and its `nodes` builder, and one
// on the backend; the panel, job store and placement need no other change.

export const STICKY_FILLS = {
  yellow: "#e3c56a",
  orange: "#d99a5b",
  pink: "#d189a7",
  purple: "#9b86c9",
  blue: "#6f9bd1",
  green: "#7fae86",
};
const STICKY_SIZE = 200;
const STICKY_GAP = 24;
const IMAGE_LONG_EDGE = 320;

function newId() {
  return crypto.randomUUID();
}

/** Columns for `count` notes: one row up to four, then a grid a little wider than tall. */
export function stickyColumns(count) {
  return count <= 4 ? Math.max(count, 1) : Math.ceil(Math.sqrt(count * 1.5));
}

/** Sticky notes laid out in a grid centred on `center`, in the order the AI returned them. */
export function stickyNodes(result, center) {
  const notes = Array.isArray(result?.notes) ? result.notes : [];
  const columns = stickyColumns(notes.length);
  const rows = Math.ceil(notes.length / columns);
  const width = columns * STICKY_SIZE + (columns - 1) * STICKY_GAP;
  const height = rows * STICKY_SIZE + (rows - 1) * STICKY_GAP;
  return notes.map((note, index) => ({
    id: newId(),
    type: "sticky",
    x: center.x - width / 2 + (index % columns) * (STICKY_SIZE + STICKY_GAP),
    y: center.y - height / 2 + Math.floor(index / columns) * (STICKY_SIZE + STICKY_GAP),
    w: STICKY_SIZE,
    h: STICKY_SIZE,
    text: String(note.text ?? ""),
    fill: STICKY_FILLS[note.color] ?? STICKY_FILLS.yellow,
    fontSize: 16,
    color: "#1c1a12",
    opacity: 1,
    parentId: null,
    groupId: null,
  }));
}

function ratioOf(aspectRatio) {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(aspectRatio ?? "").trim());
  const ratio = match ? parseFloat(match[1]) / parseFloat(match[2]) : NaN;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** One image node (320 px long edge) centred on `center`; the board only accepts /api/media/ sources. */
export function imageNodes(result, center, prompt) {
  if (typeof result?.url !== "string" || !result.url.startsWith("/api/media/")) return [];
  const ratio = ratioOf(result.aspectRatio);
  const w = ratio >= 1 ? IMAGE_LONG_EDGE : IMAGE_LONG_EDGE * ratio;
  const h = ratio >= 1 ? IMAGE_LONG_EDGE / ratio : IMAGE_LONG_EDGE;
  return [{
    id: newId(),
    type: "image",
    x: center.x - w / 2,
    y: center.y - h / 2,
    w,
    h,
    src: result.url,
    alt: typeof prompt === "string" ? prompt.slice(0, 200) : "",
    aspectLocked: false,
    parentId: null,
    groupId: null,
  }];
}

export const AI_FORMATS = {
  stickies: {
    id: "stickies",
    label: "Sticky notes",
    placeholder: "Describe the sticky notes you want, e.g. ten shot ideas for a rainy night chase",
    refinePlaceholder: "How should the notes change? e.g. make them shorter, add three more",
    advancedHint: "A stronger text model, for more considered notes",
    suggestions: [
      "Brainstorm 8 shot ideas for a 30-second product teaser",
      "List the story beats of a three-act short film about a lost dog",
      "Questions to ask before a location scout",
      "Turn a moodboard brief into 6 visual themes",
    ],
    resultLabel: (result) => {
      const count = result?.notes?.length ?? 0;
      return `${count} sticky note${count === 1 ? "" : "s"}`;
    },
    nodes: (job, center) => stickyNodes(job.result, center),
  },
  image: {
    id: "image",
    label: "Image",
    placeholder: "Describe the image, e.g. a lighthouse at dusk in heavy fog",
    refinePlaceholder: "How should the image change? e.g. make it night, add rain",
    advancedHint: "Renders at 2K where the model offers it",
    suggestions: [
      "A moody storyboard frame of a detective in a neon alley",
      "A clean product shot of a ceramic mug on linen",
      "Concept art of a floating market at sunrise",
      "A character turnaround sketch of a friendly robot",
    ],
    resultLabel: () => "1 image",
    nodes: (job, center) => imageNodes(job.result, center, job.prompt),
  },
};

export const AI_FORMAT_ORDER = ["stickies", "image"];

/** The centre of the nodes `ids` still on the board (a refinement replaces them in place), else null. */
export function placedCenter(nodes, ids) {
  const wanted = new Set(ids ?? []);
  const present = (nodes ?? []).filter((node) => wanted.has(node.id));
  if (!present.length) return null;
  const x0 = Math.min(...present.map((node) => node.x));
  const y0 = Math.min(...present.map((node) => node.y));
  const x1 = Math.max(...present.map((node) => node.x + node.w));
  const y1 = Math.max(...present.map((node) => node.y + node.h));
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
}

const FREE_MARGIN = 48;
const FREE_RINGS = 4;

function boundsOf(nodes) {
  const x0 = Math.min(...nodes.map((node) => node.x));
  const y0 = Math.min(...nodes.map((node) => node.y));
  const x1 = Math.max(...nodes.map((node) => node.x + node.w));
  const y1 = Math.max(...nodes.map((node) => node.y + node.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlaps(a, b, margin) {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

/**
 * `nodes` moved to the free spot nearest where they were built (the viewport centre): the centre itself when it is
 * clear, else the closest slot one result-width or -height away, ring by ring. A new result never lands on top of
 * the board's existing content; if every nearby slot is taken it stays at the centre.
 */
export function inFreeSpace(nodes, existing) {
  if (!nodes.length || !existing?.length) return nodes;
  const box = boundsOf(nodes);
  const others = existing.map((node) => ({ x: node.x, y: node.y, w: node.w, h: node.h }));
  const stepX = box.w + FREE_MARGIN;
  const stepY = box.h + FREE_MARGIN;
  const slots = [];
  for (let i = -FREE_RINGS; i <= FREE_RINGS; i += 1) {
    for (let j = -FREE_RINGS; j <= FREE_RINGS; j += 1) slots.push({ dx: i * stepX, dy: j * stepY });
  }
  slots.sort((a, b) => Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy) || a.dy - b.dy || a.dx - b.dx);
  const free = slots.find(({ dx, dy }) => !others.some((other) => overlaps({ ...box, x: box.x + dx, y: box.y + dy }, other, FREE_MARGIN / 2)));
  if (!free || (free.dx === 0 && free.dy === 0)) return nodes;
  return nodes.map((node) => ({ ...node, x: node.x + free.dx, y: node.y + free.dy }));
}
