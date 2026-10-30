import assert from "node:assert/strict";
import test from "node:test";
import { comboLabels, dispatchShortcut, isSingleCharacter, isTypingTarget, matchesCombo, parseCombo, registerShortcuts, shortcutEntries } from "./shortcuts.js";

// A stand-in DOM element: `inside` lists the selectors it sits within.
function element({ tagName = "DIV", editable = false, inside = [] } = {}) {
  return {
    tagName,
    isContentEditable: editable,
    nodeType: 1,
    ownerDocument: { body: null },
    closest: (selectors) => (selectors.split(",").some((s) => inside.includes(s.trim())) ? {} : null),
  };
}
const surface = element({ inside: ["[data-board-surface]"] });

function keydown(key, { code, meta = false, shift = false, alt = false, target = surface } = {}) {
  const event = {
    key,
    code: code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key),
    metaKey: meta,
    ctrlKey: false,
    shiftKey: shift,
    altKey: alt,
    target,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  return event;
}

function context(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const ctx = {
    calls,
    canEdit: true,
    viewOnly: false,
    singleKeys: true,
    store: { selection: [], history: { present: { nodes: [], connectors: [] } }, undo: record("undo"), croppingImageId: null },
    ui: { setFindOpen: record("find"), setPaletteOpen: record("palette"), setShortcutsOpen: record("help") },
    armTool: record("tool"),
    openShapes: record("shapes"),
    openImagePicker: record("image"),
    copy: record("copy"),
    cut: record("cut"),
    copyImage: record("copyImage"),
    copyStyle: record("copyStyle"),
    pasteStyle: record("pasteStyle"),
    present: record("present"),
    toolbarTools: ["select", "hand", "sticky"],
    runToolbarTool: record("dock"),
    ...overrides,
  };
  return ctx;
}

test("combos parse and match by key position when needed", () => {
  assert.deepEqual(parseCombo("Mod+Shift+C"), { key: "C", mod: true, shift: true, alt: false });
  assert.equal(matchesCombo(keydown("c", { meta: true, shift: true }), parseCombo("Mod+Shift+C")), true);
  assert.equal(matchesCombo(keydown("c", { meta: true }), parseCombo("Mod+Shift+C")), false);
  // A non-Latin layout types another character on the same key.
  assert.equal(matchesCombo(keydown("с", { code: "KeyC" }), parseCombo("C")), true);
  assert.equal(matchesCombo(keydown("!", { code: "Digit1", shift: true }), parseCombo("1")), false);
  assert.equal(isSingleCharacter(parseCombo("N")), true);
  assert.equal(isSingleCharacter(parseCombo("Shift+/")), true);
  assert.equal(isSingleCharacter(parseCombo("Mod+F")), false);
  assert.equal(isSingleCharacter(parseCombo("F1")), false);
});

test("single-key tools run on the board", () => {
  const ctx = context();
  const event = keydown("n");
  assert.equal(dispatchShortcut(event, ctx), true);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(ctx.calls, [["tool", "sticky"]]);
  dispatchShortcut(keydown("3"), ctx);
  assert.deepEqual(ctx.calls.at(-1), ["dock", "sticky"]);
});

test("nothing fires while typing in a field, an editor or a panel that owns its keys", () => {
  for (const target of [
    element({ tagName: "INPUT" }),
    element({ tagName: "TEXTAREA" }),
    element({ editable: true }),
    element({ inside: ['[role="dialog"]'] }),
    element({ inside: ['[data-board-keys="own"]'] }),
  ]) {
    const ctx = context();
    assert.equal(isTypingTarget(target), true);
    assert.equal(dispatchShortcut(keydown("n", { target }), ctx), false);
    assert.equal(dispatchShortcut(keydown("f", { meta: true, target }), ctx), false);
    assert.deepEqual(ctx.calls, []);
  }
});

test("turning single-key shortcuts off leaves modified shortcuts working", () => {
  const ctx = context({ singleKeys: false });
  assert.equal(dispatchShortcut(keydown("n"), ctx), false);
  assert.equal(dispatchShortcut(keydown("?", { code: "Slash", shift: true }), ctx), false);
  assert.equal(dispatchShortcut(keydown("1"), ctx), false);
  assert.equal(dispatchShortcut(keydown("f", { meta: true }), ctx), true);
  assert.equal(dispatchShortcut(keydown("F1"), ctx), true);
  assert.deepEqual(ctx.calls, [["find", true], ["help", true]]);
});

test("viewers get navigation tools and board actions but no editing", () => {
  const ctx = context({ canEdit: false });
  assert.equal(dispatchShortcut(keydown("n"), ctx), false);
  assert.equal(dispatchShortcut(keydown("z", { meta: true }), ctx), false);
  assert.equal(dispatchShortcut(keydown("h"), ctx), true);
  assert.equal(dispatchShortcut(keydown("k", { meta: true }), ctx), true);
  assert.deepEqual(ctx.calls, [["tool", "hand"], ["palette", true]]);
});

test("touch view-only mode keeps only the entries marked for it", () => {
  const ctx = context({ viewOnly: true });
  assert.equal(dispatchShortcut(keydown("v"), ctx), false);
  assert.equal(dispatchShortcut(keydown("f", { meta: true }), ctx), true);
});

test("Tab leaves the board past its last top-level object, and Shift+Tab before its first", () => {
  const note = (id, x) => ({ id, type: "sticky", x, y: 0, w: 100, h: 100, parentId: null, groupId: null });
  const board = (selection) => {
    const ctx = context({ store: { ...context().store, selection, history: { present: { nodes: [note("a", 0), note("b", 200)], connectors: [] } } } });
    return Object.assign(ctx, { select: (ids) => ctx.calls.push(["select", ids]) });
  };
  const step = keydown("Tab");
  const fromFirst = board(["a"]);
  assert.equal(dispatchShortcut(step, fromFirst), true);
  assert.equal(step.defaultPrevented, true);
  assert.deepEqual(fromFirst.calls, [["select", ["b"]]]);
  for (const [selection, shift] of [[["b"], false], [["a"], true]]) {
    const out = keydown("Tab", { shift });
    const ctx = board(selection);
    assert.equal(dispatchShortcut(out, ctx), false);
    assert.equal(out.defaultPrevented, false);
    assert.deepEqual(ctx.calls, []);
  }
});

test("Cmd+C copies a selection, letting the browser's copy event follow, and otherwise leaves the key to the browser", () => {
  const empty = context();
  const event = keydown("c", { meta: true });
  assert.equal(dispatchShortcut(event, empty), false);
  assert.equal(event.defaultPrevented, false);
  const selected = context({ store: { ...context().store, selection: ["n1"] } });
  const copy = keydown("c", { meta: true });
  assert.equal(dispatchShortcut(copy, selected), true);
  assert.equal(copy.defaultPrevented, false);
  assert.deepEqual(selected.calls, [["copy"]]);
  const cut = keydown("x", { meta: true });
  assert.equal(dispatchShortcut(cut, selected), true);
  assert.equal(cut.defaultPrevented, false);
  assert.deepEqual(selected.calls.at(-1), ["cut"]);
  // Cmd+Alt+C and Cmd+Alt+V copy and paste style, not objects; pasting style needs edit access.
  dispatchShortcut(keydown("ç", { code: "KeyC", meta: true, alt: true }), selected);
  assert.deepEqual(selected.calls.at(-1), ["copyStyle"]);
  const pasteStyle = keydown("√", { code: "KeyV", meta: true, alt: true });
  assert.equal(dispatchShortcut(pasteStyle, context({ canEdit: false, pasteStyle: () => assert.fail("pasted style without edit access") })), false);
  dispatchShortcut(pasteStyle, selected);
  assert.deepEqual(selected.calls.at(-1), ["pasteStyle"]);
  assert.equal(pasteStyle.defaultPrevented, true);
  dispatchShortcut(keydown("c", { meta: true, shift: true }), selected);
  assert.deepEqual(selected.calls.at(-1), ["copyImage"]);
});

test("number keys past the dock fall through", () => {
  const ctx = context();
  assert.equal(dispatchShortcut(keydown("9"), ctx), false);
});

test("other slices extend the single registry, replacing by id", () => {
  const before = shortcutEntries().length;
  const run = () => true;
  registerShortcuts([{ id: "test.extra", group: "Board", label: "Extra", keys: ["Mod+Alt+J"], run }]);
  registerShortcuts([{ id: "test.extra", group: "Board", label: "Extra again", keys: ["Mod+Alt+J"], run }]);
  assert.equal(shortcutEntries().length, before + 1);
  assert.equal(shortcutEntries().find((e) => e.id === "test.extra").label, "Extra again");
  // Every id is unique.
  const ids = shortcutEntries().map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("key labels read naturally on each platform", () => {
  assert.deepEqual(comboLabels("Mod+Shift+C", true), ["⌘", "⇧", "C"]);
  assert.deepEqual(comboLabels("Mod+Shift+C", false), ["Ctrl", "Shift", "C"]);
});
