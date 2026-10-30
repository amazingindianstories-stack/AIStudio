/**
 * Every board keyboard shortcut, in one registry: the board's key handler
 * dispatches from it, and the shortcut panel and command palette list it.
 * Other board features add their keys with `registerShortcuts`.
 *
 * An entry is `{id, group, label, keys, run?, edits?, touch?}`:
 * - `keys` are combos such as "Mod+Z", "Shift+1" or "Alt+ArrowUp" ("Mod" is
 *   Cmd on a Mac and Ctrl elsewhere); the first is the one the panel shows.
 * - `run(ctx, event)` performs it and returns false when it does not apply
 *   right now, letting the key fall through. Entries without `run` only
 *   document keys handled elsewhere (paste, space to pan).
 * - `edits` entries change the board and need edit access.
 * - `touch` entries also work while a touch device has the board view-only.
 * - `board` entries (Tab, arrows, Enter, Delete) act only while focus is on
 *   the board itself, so buttons and panels keep their own keyboard use.
 *
 * Keys typed into a text field or editor never reach the registry, and
 * single-character keys (no Cmd, Ctrl or Alt) are skipped when the person
 * has turned them off.
 */
import {
  edgeStop,
  enterContainer,
  leaveContainer,
  spatialNeighbor,
  stepStop,
} from "./keyboard-nav";

export const SHORTCUT_GROUPS = ["Tools", "Edit", "Navigate", "View", "Board"];

const CODES = { "/": "Slash", "[": "BracketLeft", "]": "BracketRight", "=": "Equal", "-": "Minus", ".": "Period", ",": "Comma" };

/** `{key, mod, shift, alt}` for a combo string such as "Mod+Shift+Z". */
export function parseCombo(spec) {
  const parts = spec.split("+");
  // "Mod++" would name the plus key; no shortcut uses it.
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return { key, mod: mods.has("mod"), shift: mods.has("shift"), alt: mods.has("alt") };
}

/** Whether a keydown event is the combo. */
export function matchesCombo(event, combo) {
  const mod = event.metaKey || event.ctrlKey;
  if (mod !== combo.mod || event.altKey !== combo.alt || event.shiftKey !== combo.shift) return false;
  const { key } = combo;
  if (/^[a-z]$/i.test(key)) {
    const code = `Key${key.toUpperCase()}`;
    // Alt changes the character on a Mac, and some layouts type no Latin letters: fall back to the key position.
    if (combo.alt || !/^[a-z]$/i.test(event.key ?? "")) return event.code === code;
    return event.key.toLowerCase() === key.toLowerCase();
  }
  if (/^\d$/.test(key)) return event.code === `Digit${key}` || event.code === `Numpad${key}`;
  if (CODES[key]) return event.code === CODES[key];
  return event.key === key;
}

/** A single-character shortcut: a printable key without Cmd, Ctrl or Alt. */
export function isSingleCharacter(combo) {
  return !combo.mod && !combo.alt && combo.key.length === 1;
}

/** Whether focus is on the board surface (or nowhere in particular). */
export function isBoardTarget(target) {
  if (!target || target === target.ownerDocument?.body || target.nodeType === 9) return true;
  return Boolean(target.closest?.("[data-board-surface]"));
}

/** Whether keys typed at `target` belong to a text field, an editor or a dialog rather than the board. */
export function isTypingTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return Boolean(target.closest?.('[data-crop-controls], [role="dialog"], [role="alertdialog"], [data-board-keys="own"]'));
}

const KEY_LABELS = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  Enter: "Enter",
  Tab: "Tab",
  " ": "Space",
};

/** The key caps for a combo, for display: ["⌘", "⇧", "Z"] on a Mac, ["Ctrl", "Shift", "Z"] elsewhere. */
export function comboLabels(spec, mac) {
  const { key, mod, shift, alt } = parseCombo(spec);
  const caps = [];
  if (mod) caps.push(mac ? "⌘" : "Ctrl");
  if (alt) caps.push(mac ? "⌥" : "Alt");
  if (shift) caps.push(mac ? "⇧" : "Shift");
  caps.push(KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key));
  return caps;
}

export function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");
}

const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const ARROW_STEP = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const arrowKeys = (prefix) => Object.keys(ARROWS).map((k) => `${prefix}${k}`);
const directionOf = (event) => ARROWS[event.key];

const present = (ctx) => ctx.store.history.present;
const hasSelection = (ctx) => ctx.store.selection.length > 0;

function tool(id, label, keys, extra = {}) {
  return { id: `tool.${id}`, group: "Tools", label, keys, run: (ctx) => ctx.armTool(id), ...extra };
}

const SHORTCUTS = [
  // ── image crop (its own Enter and Escape win while it is open) ──
  {
    id: "crop.done",
    group: "Edit",
    label: "Apply or cancel a crop",
    keys: ["Enter", "Escape"],
    hidden: true,
    run: (ctx, e) => {
      if (!ctx.store.croppingImageId) return false;
      if (e.key === "Enter") ctx.store.applyCrop();
      else ctx.store.cancelCrop();
    },
  },

  // ── tools ──
  tool("select", "Select", ["V"]),
  tool("hand", "Hand (pan)", ["H"]),
  tool("sticky", "Sticky note", ["N"], { edits: true }),
  tool("text", "Text", ["T"], { edits: true }),
  { id: "tool.shapes", group: "Tools", label: "Shapes panel", keys: ["S"], edits: true, run: (ctx) => ctx.openShapes() },
  tool("rect", "Rectangle", ["R"], { edits: true }),
  tool("ellipse", "Circle", ["O"], { edits: true }),
  tool("connector", "Connector line", ["L", "C"], { edits: true }),
  tool("frame", "Frame", ["F"], { edits: true }),
  { id: "tool.image", group: "Tools", label: "Add image", keys: ["Shift+I"], edits: true, run: (ctx) => ctx.openImagePicker() },
  {
    id: "tool.number",
    group: "Tools",
    label: "Toolbar tool by position",
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    display: ["1", "9"],
    run: (ctx, e) => {
      const index = Number(e.code.replace(/\D/g, "")) - 1;
      const entry = ctx.toolbarTools[index];
      if (!entry) return false;
      return ctx.runToolbarTool(entry);
    },
  },
  { id: "tool.place", board: true, group: "Tools", label: "Place the chosen tool at the center", keys: ["Enter"], edits: true, run: (ctx) => ctx.placeArmedTool() },
  { id: "view.pan", group: "View", label: "Pan while held", keys: [" "] },

  // ── edit ──
  { id: "edit.undo", group: "Edit", label: "Undo", keys: ["Mod+Z"], edits: true, run: (ctx) => ctx.store.undo() },
  { id: "edit.redo", group: "Edit", label: "Redo", keys: ["Mod+Shift+Z", "Mod+Y"], edits: true, run: (ctx) => ctx.store.redo() },
  { id: "edit.copy", group: "Edit", label: "Copy (also as text for other apps)", keys: ["Mod+C"], touch: true, run: (ctx) => (ctx.store.selection.length ? ctx.copy() : false) },
  { id: "edit.copyImage", group: "Edit", label: "Copy as image", keys: ["Mod+Shift+C"], touch: true, run: (ctx) => ctx.copyImage() },
  { id: "edit.cut", group: "Edit", label: "Cut", keys: ["Mod+X"], edits: true, run: (ctx) => ctx.store.cut() },
  { id: "edit.paste", group: "Edit", label: "Paste", keys: ["Mod+V"] },
  { id: "edit.duplicate", group: "Edit", label: "Duplicate", keys: ["Mod+D"], edits: true, run: (ctx) => ctx.store.duplicateSelected() },
  { id: "edit.delete", board: true, group: "Edit", label: "Delete", keys: ["Delete", "Backspace"], edits: true, run: (ctx) => ctx.store.deleteSelected() },
  { id: "edit.group", group: "Edit", label: "Group", keys: ["Mod+G"], edits: true, run: (ctx) => ctx.store.group() },
  { id: "edit.ungroup", group: "Edit", label: "Ungroup", keys: ["Mod+Shift+G"], edits: true, run: (ctx) => ctx.store.ungroup() },
  { id: "edit.forward", group: "Edit", label: "Bring forward", keys: ["Mod+]"], edits: true, run: (ctx) => ctx.store.bringForward() },
  { id: "edit.front", group: "Edit", label: "Bring to front", keys: ["Mod+Shift+]"], edits: true, run: (ctx) => ctx.store.bringToFront() },
  { id: "edit.backward", group: "Edit", label: "Send backward", keys: ["Mod+["], edits: true, run: (ctx) => ctx.store.sendBackward() },
  { id: "edit.back", group: "Edit", label: "Send to back", keys: ["Mod+Shift+["], edits: true, run: (ctx) => ctx.store.sendToBack() },
  {
    id: "edit.move", board: true,
    group: "Edit",
    label: "Move selection (Shift: 10px)",
    keys: [...arrowKeys(""), ...arrowKeys("Shift+")],
    display: ["ArrowUp"],
    edits: true,
    run: (ctx, e) => {
      if (!hasSelection(ctx)) return false;
      const [dx, dy] = ARROW_STEP[directionOf(e)];
      const step = e.shiftKey ? 10 : 1;
      ctx.store.moveSelectionBy(dx * step, dy * step);
    },
  },
  {
    id: "edit.resize", board: true,
    group: "Edit",
    label: "Resize selection (Shift: 10px)",
    keys: [...arrowKeys("Alt+"), ...arrowKeys("Alt+Shift+")],
    display: ["Alt+ArrowRight"],
    edits: true,
    run: (ctx, e) => {
      if (!hasSelection(ctx)) return false;
      const [dx, dy] = ARROW_STEP[directionOf(e)];
      const step = e.shiftKey ? 10 : 1;
      const selected = new Set(ctx.store.selection);
      const keepAspect = present(ctx).nodes.some((n) => selected.has(n.id) && n.type === "image" && n.aspectLocked);
      ctx.store.resizeSelected("se", dx * step, dy * step, keepAspect);
    },
  },
  { id: "edit.menu", board: true, group: "Edit", label: "Open the object menu", keys: ["Mod+Enter"], run: (ctx) => (hasSelection(ctx) ? ctx.openContextMenu() : false) },

  // ── navigate ──
  { id: "nav.board", group: "Navigate", label: "Focus the board", keys: ["B"], run: (ctx) => ctx.focusBoard() },
  {
    id: "nav.next", board: true,
    group: "Navigate",
    label: "Next or previous object in reading order",
    keys: ["Tab", "Shift+Tab"],
    run: (ctx, e) => {
      const ids = stepStop(present(ctx), ctx.store.selection, e.shiftKey ? -1 : 1);
      return ids ? ctx.select(ids) : false;
    },
  },
  {
    id: "nav.first", board: true,
    group: "Navigate",
    label: "First or last object",
    keys: ["Home", "End"],
    run: (ctx, e) => {
      const ids = edgeStop(present(ctx), ctx.store.selection, e.key === "End" ? "last" : "first");
      return ids ? ctx.select(ids) : false;
    },
  },
  {
    id: "nav.spatial", board: true,
    group: "Navigate",
    label: "Nearest object in that direction",
    keys: arrowKeys("Mod+"),
    display: ["Mod+ArrowRight"],
    run: (ctx, e) => {
      const id = spatialNeighbor(present(ctx), ctx.store.selection, directionOf(e));
      return id ? ctx.select([id]) : false;
    },
  },
  {
    id: "nav.extend", board: true,
    group: "Navigate",
    label: "Add the nearest object in that direction to the selection",
    keys: arrowKeys("Mod+Shift+"),
    display: ["Mod+Shift+ArrowRight"],
    run: (ctx, e) => {
      const id = spatialNeighbor(present(ctx), ctx.store.selection, directionOf(e));
      return id ? ctx.select([...ctx.store.selection, id], id) : false;
    },
  },
  {
    id: "nav.enter", board: true,
    group: "Navigate",
    label: "Go into a frame or group, or edit text",
    keys: ["Enter"],
    run: (ctx) => {
      const ids = enterContainer(present(ctx), ctx.store.selection);
      if (ids) return ctx.select(ids);
      return ctx.editSelectedText();
    },
  },
  {
    id: "nav.leave",
    group: "Navigate",
    label: "Leave a frame or group, then clear the selection",
    keys: ["Escape"],
    run: (ctx) => {
      if (ctx.store.tool !== "select") {
        ctx.store.setTool("select");
        return;
      }
      const ids = leaveContainer(present(ctx), ctx.store.selection);
      if (ids) return ctx.select(ids);
      ctx.store.clearSelection();
    },
  },
  { id: "nav.all", group: "Navigate", label: "Select all", keys: ["Mod+A"], run: (ctx) => ctx.store.selectAll() },

  // ── view ──
  {
    id: "view.actual",
    group: "View",
    label: "Zoom to 100%",
    keys: ["Mod+0"],
    touch: true,
    run: (ctx) => ctx.store.setViewport({ ...present(ctx).viewport, zoom: 1 }),
  },
  { id: "view.fit", group: "View", label: "Zoom to fit", keys: ["Shift+1"], touch: true, run: (ctx) => ctx.store.zoomToFit() },

  // ── board ──
  { id: "board.find", group: "Board", label: "Find on board", keys: ["Mod+F"], touch: true, run: (ctx) => ctx.ui.setFindOpen(true) },
  { id: "board.palette", group: "Board", label: "Command palette", keys: ["Mod+K"], touch: true, run: (ctx) => ctx.ui.setPaletteOpen(true) },
  { id: "board.present", group: "Board", label: "Present frames", keys: ["Mod+Alt+P"], touch: true, run: (ctx) => ctx.present() },
  { id: "board.help", group: "Board", label: "Keyboard shortcuts", keys: ["F1", "Shift+/"], touch: true, run: (ctx) => ctx.ui.setShortcutsOpen(true) },
];

/** Adds entries to the registry, or replaces the entry with the same id. Earlier entries win a shared key. */
export function registerShortcuts(entries) {
  for (const entry of entries) {
    const at = SHORTCUTS.findIndex((existing) => existing.id === entry.id);
    if (at >= 0) SHORTCUTS[at] = entry;
    else SHORTCUTS.push(entry);
  }
}

export function shortcutEntries() {
  return SHORTCUTS;
}

/**
 * Runs the first registry entry the keydown matches and is allowed for
 * `ctx`; true (and the browser default prevented) when one ran.
 *
 * `ctx` carries `store` (the canvas store's state), `ui` (board UI
 * actions), `canEdit`, `viewOnly` (touch view-only), `singleKeys` (the
 * person's preference) and the view callbacks the entries call.
 */
export function dispatchShortcut(event, ctx, entries = SHORTCUTS) {
  if (isTypingTarget(event.target)) return false;
  const onBoard = isBoardTarget(event.target);
  for (const entry of entries) {
    if (!entry.run) continue;
    for (const spec of entry.keys) {
      const combo = parseCombo(spec);
      if (!matchesCombo(event, combo)) continue;
      if (isSingleCharacter(combo) && !ctx.singleKeys) continue;
      if (ctx.viewOnly && !entry.touch) continue;
      if (entry.edits && !ctx.canEdit) continue;
      if (entry.board && !onBoard) continue;
      if (entry.run(ctx, event) === false) continue;
      event.preventDefault();
      return true;
    }
  }
  return false;
}
