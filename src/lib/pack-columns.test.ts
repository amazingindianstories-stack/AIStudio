import test from "node:test";
import assert from "node:assert/strict";
import { columnCount, packColumns } from "../components/AssetGrid";

/**
 * The asset grid's layout has to satisfy two properties at once, and the two
 * previous attempts each satisfied only one:
 *
 *   - balanced CSS masonry filled the gaps but re-distributed every card on
 *     each appended page (the reshuffle-while-scrolling bug);
 *   - a uniform CSS grid was append-stable but left dead space under short
 *     cards, because a grid row is as tall as its tallest member.
 *
 * APPEND-STABILITY is the one that cannot be checked by looking at a
 * screenshot, so it is pinned here.
 */

type Item = { id: string; aspectRatio?: string };

const RATIOS = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"];
const make = (n: number, offset = 0): Item[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i + offset}`,
    aspectRatio: RATIOS[(i + offset) % RATIOS.length],
  }));

/** Flatten to "which column did each id land in". */
function placement(cols: Item[][]): Map<string, number> {
  const m = new Map<string, number>();
  cols.forEach((col, ci) => col.forEach((it) => m.set(it.id, ci)));
  return m;
}

test("appending a page never moves an already-placed card", () => {
  const first = make(20);
  const before = placement(packColumns(first, 900, 160));

  // Three more pages, exactly as infinite scroll would deliver them.
  let all = first;
  for (let page = 1; page <= 3; page++) {
    all = [...all, ...make(20, page * 20)];
    const after = placement(packColumns(all, 900, 160));
    for (const [id, col] of before) {
      assert.equal(after.get(id), col, `card ${id} moved on page ${page}`);
    }
  }
});

test("re-packing the same input is deterministic", () => {
  const items = make(37);
  const a = packColumns(items, 900, 160).map((c) => c.map((i) => i.id));
  const b = packColumns(items, 900, 160).map((c) => c.map((i) => i.id));
  assert.deepEqual(a, b);
});

test("every item is placed exactly once", () => {
  const items = make(53);
  const cols = packColumns(items, 900, 160);
  const ids = cols.flat().map((i) => i.id);
  assert.equal(ids.length, items.length);
  assert.equal(new Set(ids).size, items.length);
});

test("reading order is preserved down each column", () => {
  // Masonry reorders across columns, but within a column later items must
  // never appear above earlier ones.
  const items = make(40);
  const index = new Map(items.map((it, i) => [it.id, i]));
  for (const col of packColumns(items, 900, 160)) {
    for (let i = 1; i < col.length; i++) {
      assert.ok(
        index.get(col[i].id)! > index.get(col[i - 1].id)!,
        "column is out of order"
      );
    }
  }
});

test("columns stay balanced — no column runs away", () => {
  // The point of shortest-column packing: heights should end up close, which
  // is what removes the dead space a uniform grid left behind.
  const items = make(60);
  const cols = packColumns(items, 900, 160);
  const heights = cols.map((c) =>
    c.reduce((sum, it) => {
      const [w, h] = it.aspectRatio!.split(":").map(Number);
      return sum + h / w;
    }, 0)
  );
  const spread = Math.max(...heights) - Math.min(...heights);
  // One card's worth of slack. A balanced packer cannot do better than the
  // tallest single item it had to place last.
  assert.ok(spread <= 1.9, `columns diverged by ${spread.toFixed(2)}`);
});

test("the first row fills left to right", () => {
  // Ties go to the leftmost column, so an empty grid does not start by
  // dropping the first card into the middle.
  const cols = packColumns(make(3), 900, 160);
  assert.equal(cols[0][0].id, "i0");
  assert.equal(cols[1][0].id, "i1");
  assert.equal(cols[2][0].id, "i2");
});

test("a missing or malformed aspect ratio does not break packing", () => {
  const items: Item[] = [
    { id: "a" },
    { id: "b", aspectRatio: "" },
    { id: "c", aspectRatio: "not:a:ratio" },
    { id: "d", aspectRatio: "0:0" },
    { id: "e", aspectRatio: "16:9" },
  ];
  const cols = packColumns(items, 900, 160);
  assert.equal(cols.flat().length, 5);
});

test("column count honours the zoom control's card width", () => {
  // 900px scroller − 32px padding = 868 usable.
  assert.equal(columnCount(900, 160), 5);
  assert.equal(columnCount(900, 260), 3);
  assert.equal(columnCount(900, 120), 6);
});

test("column count never drops below one", () => {
  // Before the first measurement, and in a panel narrower than one card.
  assert.equal(columnCount(0, 160), 1);
  assert.equal(columnCount(100, 260), 1);
});

test("packing into a single column keeps the original order", () => {
  const items = make(12);
  const cols = packColumns(items, 100, 260);
  assert.equal(cols.length, 1);
  assert.deepEqual(
    cols[0].map((i) => i.id),
    items.map((i) => i.id)
  );
});
