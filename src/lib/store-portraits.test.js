import assert from "node:assert/strict";
import test from "node:test";
import { useStore } from "./store";

const p = (id, createdAt, extra = {}) => ({ id, name: `Face ${id}`, imageUrl: `/api/media/uploads/portrait/${id}`, state: "ready", origin: "upload", createdAt, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

async function withStore(run) {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  const calls = [];
  try {
    useStore.setState({ portraitGalleryOpen: false, portraits: { enabled: null, items: [], next: null, loading: false, loadingMore: false, error: null, query: "" }, portraitUploads: [] });
    await run((handler) => { globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); }; }, calls);
  } finally {
    globalThis.fetch = fetchBefore;
    useStore.setState(previous, true);
  }
}

test("loadPortraits pages with the keyset cursor and passes the search", async () => {
  await withStore(async (stub, calls) => {
    stub((url) => (url.includes("cursor=c1")
      ? json({ enabled: true, portraits: [p("c", 1)], next: null })
      : json({ enabled: true, portraits: [p("a", 3), p("b", 2)], next: "c1" })));
    await useStore.getState().loadPortraits({ query: "face" });
    assert.match(calls[0].url, /^\/api\/portraits\?limit=100&q=face$/);
    let state = useStore.getState().portraits;
    assert.deepEqual(state.items.map((i) => i.id), ["a", "b"]);
    assert.equal(state.next, "c1");
    await useStore.getState().loadPortraits({ more: true });
    assert.match(calls[1].url, /cursor=c1/);
    state = useStore.getState().portraits;
    assert.deepEqual(state.items.map((i) => i.id), ["a", "b", "c"]);
    assert.equal(state.next, null);
    assert.equal(state.enabled, true);
  });
});

test("a disabled backend leaves an empty, unavailable gallery", async () => {
  await withStore(async (stub) => {
    stub(() => json({ enabled: false, portraits: [], next: null }));
    await useStore.getState().loadPortraits();
    const state = useStore.getState().portraits;
    assert.equal(state.enabled, false);
    assert.deepEqual(state.items, []);
  });
});

test("a failed load keeps the gallery undecided and reports the error", async () => {
  await withStore(async (stub) => {
    stub(() => json({ error: "boom" }, 500));
    await useStore.getState().loadPortraits();
    const state = useStore.getState().portraits;
    assert.equal(state.enabled, null);
    assert.ok(state.error);
    assert.equal(state.loading, false);
  });
});

test("deletePortraits removes at once with one request and puts refused ones back", async () => {
  await withStore(async (stub, calls) => {
    useStore.setState({ portraits: { ...useStore.getState().portraits, enabled: true, items: [p("c", 3), p("b", 2), p("a", 1)] } });
    let during = null;
    stub(() => {
      during = useStore.getState().portraits.items.map((i) => i.id);
      return json({ results: [{ id: "c", ok: true }, { id: "b", ok: false, error: "BUSY", message: "In use right now." }, { id: "a", ok: false, error: "NOT_FOUND" }] });
    });
    const result = await useStore.getState().deletePortraits(["c", "b", "a", "c"]);
    assert.deepEqual(during, [], "optimistic: all three were already gone while the request was in flight");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/portraits/delete");
    assert.deepEqual(JSON.parse(calls[0].init.body), { ids: ["c", "b", "a"] });
    assert.equal(result.ok, false);
    assert.equal(result.removed, 2, "NOT_FOUND counts as gone (someone else deleted it)");
    assert.deepEqual(result.failed, [{ id: "b", error: "In use right now." }]);
    assert.deepEqual(useStore.getState().portraits.items.map((i) => i.id), ["b"]);
  });
});

test("deletePortraits restores everything when the request itself fails", async () => {
  await withStore(async (stub) => {
    useStore.setState({ portraits: { ...useStore.getState().portraits, enabled: true, items: [p("b", 2), p("a", 1)] } });
    stub(() => { throw new Error("offline"); });
    const result = await useStore.getState().deletePortraits(["a", "b"]);
    assert.equal(result.removed, 0);
    assert.equal(result.failed.length, 2);
    assert.deepEqual(useStore.getState().portraits.items.map((i) => i.id), ["b", "a"]);
  });
});

test("renamePortrait updates the card from the server's answer", async () => {
  await withStore(async (stub, calls) => {
    useStore.setState({ portraits: { ...useStore.getState().portraits, enabled: true, items: [p("a", 1)] } });
    stub(() => json({ portrait: p("a", 1, { name: "Sati" }) }));
    const result = await useStore.getState().renamePortrait("a", "  Sati ");
    assert.equal(result.ok, true);
    assert.equal(calls[0].init.method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: "Sati" });
    assert.equal(useStore.getState().portraits.items[0].name, "Sati");
    assert.equal((await useStore.getState().renamePortrait("a", "   ")).ok, false);
  });
});

test("uploadPortraits refuses oversized and non-image files per item without any request", async () => {
  await withStore(async (stub, calls) => {
    stub(() => json({}));
    const big = { name: "big.png", type: "image/png", size: 31 * 1024 * 1024 };
    const clip = { name: "clip.mp4", type: "video/mp4", size: 100 };
    const result = await useStore.getState().uploadPortraits([big, clip]);
    assert.deepEqual(result, { added: 0, failed: 2 });
    assert.equal(calls.length, 0);
    const tiles = useStore.getState().portraitUploads;
    assert.equal(tiles.length, 2);
    assert.ok(tiles.every((t) => t.state === "error"));
    assert.match(tiles.find((t) => t.name === "big").error, /larger than 30 MB/);
    useStore.getState().dismissPortraitUpload(tiles[0].key);
    assert.equal(useStore.getState().portraitUploads.length, 1);
  });
});

test("attachPortraitsToComposer adds labelled portrait references once, closes the gallery once and skips duplicates", async () => {
  await withStore(async () => {
    useStore.setState({ portraitGalleryOpen: true, referenceImages: [], referenceKinds: [], referenceLabels: [], referenceTags: [], referenceIds: [], referenceVideos: [], referenceAudios: [] });
    const a = p("a", 1, { name: "Sati" }), b = p("b", 2, { name: "Zain" });
    let closes = 0;
    const unsubscribe = useStore.subscribe((state, before) => { if (before.portraitGalleryOpen && !state.portraitGalleryOpen) closes += 1; });
    const result = useStore.getState().attachPortraitsToComposer([a, b, a]);
    unsubscribe();
    assert.deepEqual(result, { ok: true, count: 2 });
    const state = useStore.getState();
    assert.deepEqual(state.referenceImages, [a.imageUrl, b.imageUrl]);
    assert.deepEqual(state.referenceKinds, ["portrait", "portrait"]);
    assert.deepEqual(state.referenceLabels, ["Sati", "Zain"]);
    assert.equal(state.portraitGalleryOpen, false);
    assert.equal(closes, 1);
    useStore.setState({ portraitGalleryOpen: true });
    assert.deepEqual(useStore.getState().attachPortraitsToComposer([a]), { ok: true, count: 0 });
    assert.equal(useStore.getState().referenceImages.length, 2);
  });
});

test("attachPortraitsToComposer refuses unusable portraits and more than 50 references", async () => {
  await withStore(async () => {
    useStore.setState({ portraitGalleryOpen: true, referenceImages: Array(49).fill("/x"), referenceKinds: Array(49).fill("image"), referenceLabels: [], referenceTags: [], referenceIds: [], referenceVideos: [], referenceAudios: [] });
    assert.equal(useStore.getState().attachPortraitsToComposer([p("a", 1, { state: "unusable" })]).ok, false);
    const over = useStore.getState().attachPortraitsToComposer([p("a", 1), p("b", 2)]);
    assert.equal(over.ok, false);
    assert.match(over.error, /at most 50/);
    assert.equal(useStore.getState().portraitGalleryOpen, true);
    assert.equal(useStore.getState().referenceImages.length, 49);
  });
});
