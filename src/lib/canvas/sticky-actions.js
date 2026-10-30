/**
 * Sticky, tag and style actions on the open board. Each reads the board from
 * the store (never the DOM, so culled objects count) and changes it through
 * `editBoard`, one undo step per action, saved with the board's per-object
 * saves. Read-only boards change nothing: `editBoard` ignores them.
 */
import { selectReadOnly, applyStylePatchToNode, useCanvasStore } from "@/lib/canvas-store";
import { useStore } from "@/lib/store";
import { toggleReaction } from "./reactions";
import {
  bulkStickies,
  clusterGroups,
  clusterLayout,
  limitCells,
  stickiesCsv,
  stickiesFromGrid,
  stickyFromStack,
  withStickyShape,
  DEFAULT_STICKY_COLOR,
} from "./stickies";
import { addTag, deleteTag, nodesWithTag, setTagOn, updateTag } from "./tags";
import { canSwitchType, rememberStyle, styleKind, styleOf, switchType, withLastStyle } from "./styles";
import { nodeBounds } from "./geometry";

function canvas() {
  return useCanvasStore.getState();
}

export function currentUserId() {
  return useStore.getState().currentUser?.id ?? null;
}

function editable() {
  const state = canvas();
  return Boolean(state.boardId) && !selectReadOnly(state);
}

function selectedNodes(state = canvas()) {
  const ids = new Set(state.selection);
  return state.history.present.nodes.filter((node) => ids.has(node.id));
}

function select(ids) {
  canvas().setSelection(ids);
}

/** The style a new sticky takes: auto font size, the default color, then the person's last sticky style. */
export function newStickyStyle() {
  const style = withLastStyle({ type: "sticky", fill: DEFAULT_STICKY_COLOR.value, color: DEFAULT_STICKY_COLOR.ink, fontSize: 16, autoFit: true }, currentUserId());
  return { fill: style.fill, color: style.color, fontSize: style.fontSize, autoFit: style.autoFit, fontFamily: style.fontFamily };
}

function addNodes(nodes) {
  if (!nodes.length || !editable()) return false;
  canvas().editBoard((present) => ({ ...present, nodes: [...present.nodes, ...nodes] }));
  select(nodes.map((node) => node.id));
  return true;
}

/** Bulk mode: one sticky per line of `text`, centered on `center`. Returns how many it added. */
export function addBulkStickies(text, center) {
  const nodes = bulkStickies(text, center, newStickyStyle());
  return addNodes(nodes) ? nodes.length : 0;
}

/** Spreadsheet paste: one sticky per non-blank cell. Returns `{added, truncated}`. */
export function pasteCellsAsStickies(rows, center) {
  const { rows: kept, truncated } = limitCells(rows);
  const nodes = stickiesFromGrid(kept, center, newStickyStyle());
  return { added: addNodes(nodes) ? nodes.length : 0, truncated };
}

/** Adds a sticky stack centered on `center`. */
export function addStickyStack(center) {
  const side = 200;
  return addNodes([{ id: crypto.randomUUID(), type: "stack", x: center.x - side / 2, y: center.y - side / 2, w: side, h: side,
    opacity: 1, parentId: null, groupId: null, fill: newStickyStyle().fill }]);
}

/**
 * Peels a blank sticky off `stack` and selects it, as the first step of a
 * drag (coalesced, so the drag that follows is the same undo step).
 */
export function takeStickyFromStack(stack) {
  if (!editable()) return;
  const node = stickyFromStack(stack, { x: stack.x + stack.w / 2, y: stack.y + stack.h / 2 }, newStickyStyle());
  canvas().editBoard((present) => ({ ...present, nodes: [...present.nodes, node] }), { coalesce: true });
  select([node.id]);
}

/** Adds or takes back this person's `emoji` vote on sticky `id`. */
export function toggleStickyReaction(id, emoji) {
  const userId = currentUserId();
  if (!userId || !editable()) return;
  canvas().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((node) => (node.id === id && node.type === "sticky" ? toggleReaction(node, emoji, userId) : node)),
  }));
}

/** Adds this person's `emoji` vote to every selected sticky when `on`, otherwise takes it back. */
export function setReactionOnSelection(emoji, on) {
  const userId = currentUserId();
  if (!userId || !editable()) return;
  const ids = new Set(canvas().selection);
  canvas().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((node) => {
      if (!ids.has(node.id) || node.type !== "sticky") return node;
      const mine = Boolean(node.reactions?.[emoji]?.includes(userId));
      return mine === on ? node : toggleReaction(node, emoji, userId);
    }),
  }));
}

/** Square or rectangular shape for every selected sticky. */
export function setSelectedStickyShape(shape) {
  const ids = new Set(selectedNodes().filter((node) => node.type === "sticky").map((node) => node.id));
  if (!ids.size) return;
  canvas().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((node) => (ids.has(node.id) ? withStickyShape(node, shape) : node)),
  }));
}

/** Turns one setting of the selected stickies on or off (`showAuthor`). */
export function setSelectedStickyFlag(key, on) {
  const ids = new Set(selectedNodes().filter((node) => node.type === "sticky").map((node) => node.id));
  if (!ids.size) return;
  canvas().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((node) => {
      if (!ids.has(node.id) || Boolean(node[key]) === on) return node;
      const next = { ...node };
      if (on) next[key] = true;
      else delete next[key];
      return next;
    }),
  }));
}

// ---- tags ----

/** Creates tag `name` (or finds it) and puts it on the selected stickies. */
export function addTagToSelection(name) {
  const ids = selectedNodes().filter((node) => node.type === "sticky").map((node) => node.id);
  let tag = null;
  canvas().editBoard((present) => {
    const added = addTag(present, name);
    tag = added.tag;
    return tag ? setTagOn(added.state, ids, tag.id, true) : present;
  });
  return tag;
}

export function setTagOnSelection(tagId, on) {
  const ids = selectedNodes().filter((node) => node.type === "sticky").map((node) => node.id);
  canvas().editBoard((present) => setTagOn(present, ids, tagId, on));
}

export function editTag(tagId, changes) {
  canvas().editBoard((present) => updateTag(present, tagId, changes));
}

export function removeTag(tagId) {
  canvas().editBoard((present) => deleteTag(present, tagId));
}

/** Selects every object with tag `tagId`, wherever it is on the board. */
export function selectByTag(tagId) {
  select(nodesWithTag(canvas().history.present, tagId));
}

// ---- CSV and clustering ----

/** Downloads the selected stickies as CSV. Returns how many it exported. */
export function exportSelectedStickies(personName, boardName = "board") {
  const state = canvas();
  const stickies = selectedNodes(state).filter((node) => node.type === "sticky");
  if (!stickies.length) return 0;
  const csv = stickiesCsv(stickies, state.history.present.tags ?? [], personName);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${boardName.replace(/[\\/:*?"<>|]+/g, " ").trim() || "board"} stickies.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return stickies.length;
}

/** Arranges the selected stickies into titled groups by "tag", "color" or "author", selecting the result. */
export function clusterSelection(by, personName) {
  const state = canvas();
  const stickies = selectedNodes(state).filter((node) => node.type === "sticky");
  if (stickies.length < 2 || !editable()) return;
  const origin = stickies.reduce((at, node) => {
    const bounds = nodeBounds(node);
    return { x: Math.min(at.x, bounds.x), y: Math.min(at.y, bounds.y) };
  }, { x: Infinity, y: Infinity });
  const groups = clusterGroups(stickies, by, { tags: state.history.present.tags ?? [], personName });
  const { positions, titles } = clusterLayout(groups, origin, { color: "#ffffff" });
  canvas().editBoard((present) => ({
    ...present,
    nodes: [
      ...present.nodes.map((node) => {
        const at = positions.get(node.id);
        // Clustered stickies leave their group and frame, which no longer hold them.
        return at ? { ...node, ...at, parentId: null, groupId: null } : node;
      }),
      ...titles,
    ],
  }));
  select([...positions.keys(), ...titles.map((title) => title.id)]);
}

// ---- styles ----

let copiedStyle = null;

/** Copies the style of the first selected object (Cmd+Alt+C). */
export function copySelectionStyle() {
  const node = selectedNodes()[0];
  if (!node) return false;
  copiedStyle = { kind: styleKind(node), style: styleOf(node) };
  return true;
}

export function hasCopiedStyle() {
  return copiedStyle !== null;
}

/** Applies the copied style to every selected object that can take it (Cmd+Alt+V), as one undo step. */
export function pasteSelectionStyle() {
  if (!copiedStyle || !editable()) return false;
  const ids = new Set(canvas().selection);
  if (!ids.size) return false;
  const { style } = copiedStyle;
  canvas().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((node) => {
      if (!ids.has(node.id)) return node;
      const patch = { ...style };
      if (node.type !== "rect") delete patch.cornerRadius;
      // A shape that has no text keeps it unset rather than gaining text styling.
      if (styleKind(node) === "shape" && !node.text) {
        delete patch.color;
        delete patch.fontSize;
        delete patch.fontFamily;
      }
      if (style.fontSize !== undefined && style.autoFit === undefined) patch.autoFit = false;
      return applyStylePatchToNode(node, patch) ?? node;
    }),
  }));
  return true;
}

/** Remembers a style change on the selection, so new objects of the same kinds take it. */
export function rememberSelectionStyle(nodes, patch) {
  const userId = currentUserId();
  for (const kind of new Set(nodes.map(styleKind))) if (kind) rememberStyle(userId, kind, patch);
}

/** Switches every selected sticky, text box and shape to type `to`, as one undo step. */
export function switchSelectionType(to) {
  const ids = new Set(selectedNodes().filter(canSwitchType).map((node) => node.id));
  if (!ids.size) return;
  canvas().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((node) => (ids.has(node.id) ? switchType(node, to) : node)),
  }));
}
