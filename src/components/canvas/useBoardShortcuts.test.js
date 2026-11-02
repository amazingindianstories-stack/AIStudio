import assert from "node:assert/strict";
import test from "node:test";
import { startPresentation } from "./useBoardShortcuts.js";
import { stopPresentation } from "./BoardPresentation.jsx";
import { useBoardUi } from "../../lib/canvas/board-ui.js";
import { useCanvasStore } from "../../lib/canvas-store.js";

test("starting the presentation again from a board break still returns to the view from before it", () => {
  const frame = { id: "f", type: "frame", name: "Intro", x: 0, y: 0, w: 400, h: 300, parentId: null, groupId: null };
  const before = { x: 10, y: 20, zoom: 1 };
  useCanvasStore.setState({ history: { past: [], present: { version: 1, viewport: before, nodes: [frame], connectors: [] }, future: [] } });
  try {
    startPresentation();
    const ui = useBoardUi.getState();
    ui.setPresenting({ ...ui.presenting, index: 0, onBoard: true });
    useCanvasStore.getState().showViewport({ x: 500, y: 500, zoom: 2 });
    startPresentation();
    assert.deepEqual(useBoardUi.getState().presenting.returnViewport, before);
    stopPresentation();
    assert.equal(useBoardUi.getState().presenting, null);
    assert.deepEqual(useCanvasStore.getState().history.present.viewport, before);
  } finally {
    useBoardUi.getState().setPresenting(null);
    useCanvasStore.getState().reset();
  }
});
