import test from "node:test";
import assert from "node:assert/strict";
import { recognizeStroke, scribbleTargets, countReversals } from "./smart-draw.js";

function trace(corners, perSide = 12, close = true) {
  const out = [];
  const list = close ? [...corners, corners[0]] : corners;
  for (let i = 0; i + 1 < list.length; i += 1) {
    for (let s = 0; s < perSide; s += 1) {
      const t = s / perSide;
      out.push({ x: list[i].x + (list[i + 1].x - list[i].x) * t + (s % 3) * 0.3, y: list[i].y + (list[i + 1].y - list[i].y) * t });
    }
  }
  out.push(list[list.length - 1]);
  return out;
}

function ellipse(cx, cy, rx, ry, n = 60) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
  });
}

test("a wide closed four-corner stroke becomes a rectangle", () => {
  const stroke = trace([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]);
  const result = recognizeStroke(stroke);
  assert.equal(result.kind, "shape");
  assert.equal(result.shape, "rect");
});

test("a squarish four-corner stroke becomes a sticky note", () => {
  const stroke = trace([{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 120 }, { x: 0, y: 120 }]);
  assert.equal(recognizeStroke(stroke).kind, "sticky");
});

test("a round stroke becomes an ellipse", () => {
  const result = recognizeStroke(ellipse(100, 60, 90, 50));
  assert.equal(result.shape, "ellipse");
  assert.ok(Math.abs(result.box.w - 180) < 2);
});

test("a three-corner stroke becomes a triangle", () => {
  const stroke = trace([{ x: 100, y: 0 }, { x: 200, y: 160 }, { x: 0, y: 160 }]);
  assert.equal(recognizeStroke(stroke).shape, "triangle");
});

test("a stroke through the four edge middles becomes a diamond", () => {
  const stroke = trace([{ x: 100, y: 0 }, { x: 200, y: 80 }, { x: 100, y: 160 }, { x: 0, y: 80 }]);
  assert.equal(recognizeStroke(stroke).shape, "diamond");
});

test("a straight open stroke becomes a line between its ends", () => {
  const stroke = trace([{ x: 10, y: 10 }, { x: 310, y: 60 }], 30, false);
  const result = recognizeStroke(stroke);
  assert.equal(result.kind, "line");
  assert.deepEqual([result.from.x > 5, result.to.x > 300], [true, true]);
});

test("a zigzag scribble erases and a tiny dot stays ink", () => {
  const zigzag = [];
  for (let i = 0; i < 10; i += 1) zigzag.push({ x: i % 2 ? 60 : 0, y: i * 6 });
  const dense = trace(zigzag, 8, false);
  assert.ok(countReversals(dense) >= 4);
  assert.equal(recognizeStroke(dense).kind, "erase");
  assert.equal(recognizeStroke([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]), null);
});

test("a scribble targets objects it passes through, never frames", () => {
  const nodes = [
    { id: "a", type: "rect", x: 0, y: 0, w: 100, h: 100 },
    { id: "far", type: "rect", x: 500, y: 500, w: 50, h: 50 },
    { id: "frame", type: "frame", x: 0, y: 0, w: 400, h: 400 },
  ];
  const points = Array.from({ length: 10 }, (_, i) => ({ x: i % 2 ? 80 : 10, y: i * 8 }));
  assert.deepEqual(scribbleTargets(nodes, points), ["a"]);
});
