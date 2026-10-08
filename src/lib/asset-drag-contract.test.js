import test from "node:test";
import assert from "node:assert/strict";
import {
  VEEVEE_ASSET_MIME,
  LEGACY_ITEM_ID_MIME,
  LEGACY_ASSET_ID_MIME,
  setAssetDragData,
  getAssetDragData,
  setFolderDragData,
  getFolderDragData,
  isAssetDragEvent,
  isFolderDragEvent,
  isExternalFileDrag,
} from "./asset-drag-contract.js";

// Mock DataTransfer implementation for testing
class MockDataTransfer {
  constructor() {
    this.data = new Map();
    this.types = [];
    this.effectAllowed = "uninitialized";
  }

  setData(format, value) {
    this.data.set(format, String(value));
    if (!this.types.includes(format)) {
      this.types.push(format);
    }
  }

  getData(format) {
    return this.data.get(format) || "";
  }
}

test("setAssetDragData stores canonical JSON and backwards-compatible mime types", () => {
  const dt = new MockDataTransfer();
  const items = [
    { id: "item-1", url: "https://example.com/1.png", kind: "image", prompt: "first" },
    { id: "item-2", url: "https://example.com/2.mp4", kind: "video", prompt: "second" },
  ];

  setAssetDragData(dt, items, items[0]);

  assert.equal(dt.getData(LEGACY_ITEM_ID_MIME), "item-1");
  assert.equal(dt.getData(LEGACY_ASSET_ID_MIME), "item-1");
  assert.equal(dt.getData("text/plain"), "https://example.com/1.png\nhttps://example.com/2.mp4");
  assert.equal(dt.effectAllowed, "copyMove");

  const canonicalRaw = dt.getData(VEEVEE_ASSET_MIME);
  assert.ok(canonicalRaw, "Canonical MIME should be present");
  const parsed = JSON.parse(canonicalRaw);
  assert.deepEqual(parsed.ids, ["item-1", "item-2"]);
  assert.equal(parsed.count, 2);
  assert.equal(parsed.primaryId, "item-1");
});

test("getAssetDragData parses canonical multi-selection payload", () => {
  const dt = new MockDataTransfer();
  const items = [
    { id: "gen-a", url: "https://example.com/a.png", kind: "image" },
    { id: "gen-b", url: "https://example.com/b.png", kind: "image" },
    { id: "gen-c", url: "https://example.com/c.png", kind: "image" },
  ];
  setAssetDragData(dt, items, items[1]);

  const result = getAssetDragData(dt);
  assert.equal(result.count, 3);
  assert.deepEqual(result.ids, ["gen-a", "gen-b", "gen-c"]);
  assert.equal(result.primaryItem.id, "gen-b");
});

test("getAssetDragData falls back cleanly to legacy text/itemId", () => {
  const dt = new MockDataTransfer();
  dt.setData(LEGACY_ITEM_ID_MIME, "legacy-42");

  const result = getAssetDragData(dt);
  assert.equal(result.count, 1);
  assert.deepEqual(result.ids, ["legacy-42"]);
  assert.equal(result.primaryItem.id, "legacy-42");
});

test("getAssetDragData falls back to store state when dataTransfer is empty (dragover in Chrome)", () => {
  const dt = new MockDataTransfer(); // no getData available yet during dragover
  const storeState = {
    draggedAssets: [
      { id: "s-1", kind: "image" },
      { id: "s-2", kind: "image" },
    ],
    draggedItem: { id: "s-1", kind: "image" },
  };

  const result = getAssetDragData(dt, storeState);
  assert.equal(result.count, 2);
  assert.deepEqual(result.ids, ["s-1", "s-2"]);
  assert.equal(result.primaryItem.id, "s-1");
});

test("setFolderDragData and getFolderDragData handle folders", () => {
  const dt = new MockDataTransfer();
  setFolderDragData(dt, "folder-99", "Scene Assets");

  assert.equal(isFolderDragEvent({ dataTransfer: dt }), true);
  assert.equal(isAssetDragEvent({ dataTransfer: dt }), false);

  const parsedFolderId = getFolderDragData(dt);
  assert.equal(parsedFolderId, "folder-99");
});

test("drag event type detection distinguishes assets, folders, and external files", () => {
  const assetDt = new MockDataTransfer();
  assetDt.types = [VEEVEE_ASSET_MIME, "text/itemId"];
  assert.equal(isAssetDragEvent({ dataTransfer: assetDt }), true);
  assert.equal(isExternalFileDrag({ dataTransfer: assetDt }), false);

  const fileDt = new MockDataTransfer();
  fileDt.types = ["Files"];
  assert.equal(isAssetDragEvent({ dataTransfer: fileDt }), false);
  assert.equal(isFolderDragEvent({ dataTransfer: fileDt }), false);
  assert.equal(isExternalFileDrag({ dataTransfer: fileDt }), true);
});

test("buildAssetDragBadgeElement prevents XSS by rendering malicious prompts as plain textContent without HTML parsing", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  const prevDoc = global.document;
  global.document = dom.window.document;

  try {
    const { buildAssetDragBadgeElement } = await import("./asset-drag-contract.js");
    const maliciousItem = {
      id: "malicious-1",
      prompt: '<script>window.pwned=true</script><img src="x" onerror="evil()">',
    };

    const singleBadge = buildAssetDragBadgeElement(maliciousItem, 1);
    assert.ok(singleBadge, "Badge element should be created");

    // Must not create HTML child elements from prompt
    assert.equal(singleBadge.querySelectorAll("script").length, 0, "No <script> tag should exist");
    assert.equal(singleBadge.querySelectorAll("img").length, 0, "No <img> tag should exist");

    // Text content must contain the prompt string safely escaped/truncated
    assert.ok(
      singleBadge.textContent.includes("<script>window.pwned="),
      "Prompt text should be preserved safely as textContent"
    );

    // Multi-asset count badge test
    const multiBadge = buildAssetDragBadgeElement(maliciousItem, 5);
    assert.ok(multiBadge);
    assert.equal(multiBadge.querySelectorAll("script").length, 0);
    assert.ok(multiBadge.textContent.includes("Moving 5 assets"));
  } finally {
    global.document = prevDoc;
  }
});

test("isFolderDescendant detects self and nested descendants", async () => {
  const { isFolderDescendant } = await import("./asset-drag-contract.js");
  const tree = [
    {
      id: "root-1",
      children: [
        {
          id: "child-1",
          children: [
            { id: "grandchild-1", children: [] },
          ],
        },
      ],
    },
    { id: "root-2", children: [] },
  ];

  assert.equal(isFolderDescendant(tree, "root-1", "root-1"), true, "Self is descendant");
  assert.equal(isFolderDescendant(tree, "root-1", "child-1"), true, "Direct child is descendant");
  assert.equal(isFolderDescendant(tree, "root-1", "grandchild-1"), true, "Grandchild is descendant");
  assert.equal(isFolderDescendant(tree, "child-1", "root-1"), false, "Ancestor is not descendant of child");
  assert.equal(isFolderDescendant(tree, "root-1", "root-2"), false, "Sibling is not descendant");
});

test("validateUpscalerDrop rejects video-only payloads and accepts images", async () => {
  const { validateUpscalerDrop } = await import("./asset-drag-contract.js");

  const videoDt = new MockDataTransfer();
  videoDt.types = [VEEVEE_ASSET_MIME];
  const videoState = {
    draggedAssets: [{ id: "v1", kind: "video" }],
  };
  const videoResult = validateUpscalerDrop({ dataTransfer: videoDt }, videoState);
  assert.equal(videoResult.valid, false);
  assert.match(videoResult.reason, /Upscaler only accepts images/);

  const imageDt = new MockDataTransfer();
  imageDt.types = [VEEVEE_ASSET_MIME];
  const imageState = {
    draggedAssets: [{ id: "i1", kind: "image" }],
  };
  const imageResult = validateUpscalerDrop({ dataTransfer: imageDt }, imageState);
  assert.equal(imageResult.valid, true);

  const fileDt = new MockDataTransfer();
  fileDt.types = ["Files"];
  const fileResult = validateUpscalerDrop({ dataTransfer: fileDt }, null);
  assert.equal(fileResult.valid, true);
});

test("validateDepthDrop rejects Asset Library generations and accepts direct files", async () => {
  const { validateDepthDrop } = await import("./asset-drag-contract.js");

  const assetDt = new MockDataTransfer();
  assetDt.types = [VEEVEE_ASSET_MIME];
  const assetState = {
    draggedAssets: [{ id: "g1", kind: "video" }],
  };
  const assetResult = validateDepthDrop({ dataTransfer: assetDt }, assetState);
  assert.equal(assetResult.valid, false);
  assert.match(assetResult.reason, /Direct video file uploads only/);

  const fileDt = new MockDataTransfer();
  fileDt.types = ["Files"];
  const fileResult = validateDepthDrop({ dataTransfer: fileDt }, null);
  assert.equal(fileResult.valid, true);
});

test("validatePortraitDrop rejects video-only payloads and accepts images", async () => {
  const { validatePortraitDrop } = await import("./asset-drag-contract.js");

  const videoDt = new MockDataTransfer();
  videoDt.types = [VEEVEE_ASSET_MIME];
  const videoState = {
    draggedAssets: [{ id: "v1", kind: "video" }],
  };
  const videoResult = validatePortraitDrop({ dataTransfer: videoDt }, videoState);
  assert.equal(videoResult.valid, false);
  assert.match(videoResult.reason, /Portrait Gallery only accepts images/);

  const imageDt = new MockDataTransfer();
  imageDt.types = [VEEVEE_ASSET_MIME];
  const imageState = {
    draggedAssets: [{ id: "p1", kind: "image" }],
  };
  const imageResult = validatePortraitDrop({ dataTransfer: imageDt }, imageState);
  assert.equal(imageResult.valid, true);
});

test("createDropzoneFlickerGuard eliminates nested child dragleave flicker", async () => {
  const { createDropzoneFlickerGuard } = await import("./asset-drag-contract.js");

  let active = false;
  const guard = createDropzoneFlickerGuard((state) => {
    active = state;
  });

  // 1. Enter parent container
  guard.enter({});
  assert.equal(active, true);
  assert.equal(guard.count, 1);

  // 2. Enter nested child element (bubbles dragenter to parent)
  guard.enter({});
  assert.equal(active, true);
  assert.equal(guard.count, 2);

  // 3. Leave parent to child (fires dragleave on parent)
  guard.leave({});
  assert.equal(active, true, "Should stay active when leaving parent to child");
  assert.equal(guard.count, 1);

  // 4. Leave child to outside
  guard.leave({});
  assert.equal(active, false, "Should become inactive only when count reaches 0");
  assert.equal(guard.count, 0);
});


