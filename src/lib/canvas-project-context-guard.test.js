import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const view = readFileSync("src/components/canvas/CanvasView.jsx", "utf8");
const switcher = readFileSync("src/components/canvas/BoardSwitcher.jsx", "utf8");
const assets = readFileSync("src/components/canvas/CanvasAssetPanel.jsx", "utf8");

test("Canvas exposes board ownership separately from the asset-source filter", () => {
  assert.match(view, /<BoardProjectSelector/);
  assert.match(assets, /Assets from:/);
  assert.doesNotMatch(assets, /useStore\(\(s\) => s\.setActiveProject/);
});

test("Canvas clears the old board before changing its owning project", () => {
  const handler = view.slice(
    view.indexOf("const handleBoardProjectChange"),
    view.indexOf("const placeAsset")
  );
  assert.ok(handler.indexOf("setBoardId(null)") >= 0);
  assert.ok(handler.indexOf("setBoardId(null)") < handler.indexOf("setActiveProject(projectId)"));
});

test("BoardSwitcher rejects stale project-list responses", () => {
  assert.match(switcher, /const requestId = \+\+requestIdRef\.current/);
  assert.ok(
    (switcher.match(/requestIdRef\.current !== requestId/g) || []).length >= 2,
    "both list-fetch and auto-create responses must be fenced"
  );
  assert.match(switcher, /encodeURIComponent\(projectId\)/);
});
