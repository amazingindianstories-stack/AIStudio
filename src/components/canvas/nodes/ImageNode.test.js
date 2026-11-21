import test from "node:test";
import assert from "node:assert/strict";
import { imageNodePropsEqual } from "./ImageNode.jsx";
import * as cropHandlers from "../../../lib/canvas/crop-handlers.js";

const node = { id: "n", type: "image", src: "/api/media/canvas/b/a.png", x: 0, y: 0, w: 320, h: 200 };
const propsFor = (viewport) => ({
  node,
  cropMode: false,
  cropDraft: null,
  onCropChange: cropHandlers.onCropChange,
  onApplyCrop: cropHandlers.onApplyCrop,
  onCancelCrop: cropHandlers.onCancelCrop,
  onResetCrop: cropHandlers.onResetCrop,
  viewport,
  viewportSize: { w: 1600, h: 900 },
});

test("ImageNode memo skips pan and zoom frames that keep its visibility and tier", () => {
  assert.equal(imageNodePropsEqual(propsFor({ x: 0, y: 0, zoom: 0.5 }), propsFor({ x: -30, y: 12, zoom: 0.52 })), true);
  assert.equal(imageNodePropsEqual(propsFor({ x: 0, y: 0, zoom: 0.5 }), propsFor({ x: 0, y: 0, zoom: 1 })), false);
  assert.equal(imageNodePropsEqual(propsFor({ x: 0, y: 0, zoom: 0.5 }), propsFor({ x: -100000, y: 0, zoom: 0.5 })), false);
});
