import test from "node:test";
import assert from "node:assert/strict";
import { useStore } from "./store.js";

test("useStore reference methods manage tags and materials", () => {
  // Reset references
  useStore.setState({
    prompt: "A scene with ",
    referenceImages: [],
    referenceKinds: [],
    referenceLabels: [],
    referenceTags: [],
  });

  // 1. Add ad-hoc reference (kind='image')
  useStore.getState().addReference("data:image/png;base64,111", "image", "", "");
  let s = useStore.getState();
  assert.equal(s.referenceImages.length, 1);
  assert.equal(s.referenceKinds[0], "image");
  assert.equal(s.referenceTags[0], "");

  // 2. Attach a Material Library asset
  const materialAsset = {
    id: "mat-1",
    name: "Sati",
    slug: "sati",
    kind: "character",
    images: ["data:image/png;base64,SATI_IMG"],
  };

  useStore.getState().attachMaterialToComposer(materialAsset);
  s = useStore.getState();
  assert.equal(s.referenceImages.length, 2);
  assert.equal(s.referenceImages[1], "data:image/png;base64,SATI_IMG");
  assert.equal(s.referenceKinds[1], "material");
  assert.equal(s.referenceLabels[1], "Sati");
  assert.equal(s.referenceTags[1], "@sati");
  assert.match(s.prompt, /@sati/);
  assert.equal(s.assetLibraryOpen, false);

  // 3. Reorder references (swap 0 and 1)
  const newOrder = [s.referenceImages[1], s.referenceImages[0]];
  useStore.getState().reorderReferences(newOrder);
  s = useStore.getState();
  assert.equal(s.referenceImages[0], "data:image/png;base64,SATI_IMG");
  assert.equal(s.referenceTags[0], "@sati");
  assert.equal(s.referenceKinds[0], "material");
  assert.equal(s.referenceImages[1], "data:image/png;base64,111");
  assert.equal(s.referenceTags[1], "");

  // 4. Remove reference at index 0
  useStore.getState().removeReference(0);
  s = useStore.getState();
  assert.equal(s.referenceImages.length, 1);
  assert.equal(s.referenceImages[0], "data:image/png;base64,111");
  assert.equal(s.referenceTags[0], "");
  assert.equal(s.referenceKinds[0], "image");
});

test("saveAsset returns ok: true on success and updates assets store", async () => {
  const originalFetch = global.fetch;
  const mockAsset = {
    id: "new-mat-1",
    name: "Cyber Sword",
    slug: "cyber-sword",
    kind: "prop",
    images: ["/api/media/uploads/sword.png"],
  };

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockAsset,
  });

  try {
    const res = await useStore.getState().saveAsset({
      name: "Cyber Sword",
      kind: "prop",
      image: "/api/media/uploads/sword.png",
    });

    assert.equal(res.ok, true);
    assert.equal(res.asset.id, "new-mat-1");
    const s = useStore.getState();
    assert.ok(s.assets.some((a) => a.id === "new-mat-1"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("saveAsset returns ok: false and error message on server failure", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "AccessDenied: user is not authorized" }),
  });

  try {
    const res = await useStore.getState().saveAsset({
      name: "Broken Asset",
      kind: "prop",
      image: "data:image/png;base64,...",
    });

    assert.equal(res.ok, false);
    assert.match(res.error, /AccessDenied/);
  } finally {
    global.fetch = originalFetch;
  }
});
