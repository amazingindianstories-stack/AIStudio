import assert from "node:assert/strict";
import test from "node:test";
import { placeDropdownPanel } from "./Dropdown";

const viewport = { width: 844, height: 390 };
const trigger = { left: 700, right: 800, top: 160, bottom: 192 };

test("a panel opens on its preferred side when it fits", () => {
  assert.deepEqual(placeDropdownPanel({ trigger, width: 190, height: 120, viewport, align: "right", side: "bottom" }),
    { left: 610, top: 200, maxHeight: 120 });
  assert.deepEqual(placeDropdownPanel({ trigger, width: 190, height: 120, viewport, align: "right", side: "top" }),
    { left: 610, top: 32, maxHeight: 120 });
});

test("a panel flips when only the other side fits", () => {
  const low = { ...trigger, top: 300, bottom: 332 };
  assert.deepEqual(placeDropdownPanel({ trigger: low, width: 190, height: 160, viewport, align: "right", side: "bottom" }),
    { left: 610, top: 132, maxHeight: 160 });
});

test("a panel that fits neither side scrolls on the roomier side instead of covering its trigger", () => {
  const placed = placeDropdownPanel({ trigger, width: 190, height: 200, viewport, align: "right", side: "bottom" });
  assert.deepEqual(placed, { left: 610, top: 200, maxHeight: 182 });
  assert.ok(placed.top >= trigger.bottom);
  const high = { ...trigger, top: 230, bottom: 262 };
  const above = placeDropdownPanel({ trigger: high, width: 190, height: 300, viewport, align: "left", side: "bottom" });
  assert.deepEqual(above, { left: 646, top: 8, maxHeight: 214 });
  assert.ok(above.top + above.maxHeight <= high.top);
});
