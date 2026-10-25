import assert from "node:assert/strict";
import test from "node:test";
import { useStore } from "./store";
import { useNotices } from "./notify";

test("Seedance structured rejection displays its message and does not retry or clear the draft", async () => {
  const previous = useStore.getState();
  const calls = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: "Motion reference dimensions are invalid" } }), { status: 400 });
  };
  useNotices.setState({ notices: [] });
  useStore.setState({ mode: "video", model: "Seedance 2.5", prompt: "Keep this draft", generating: false, batchCount: 3, referenceImages: [], referenceVideos: [], items: [], pendingItems: [] });
  try {
    await useStore.getState().generate();
    assert.deepEqual(useNotices.getState().notices.map((notice) => notice.text), ["Motion reference dimensions are invalid"]);
    assert.equal(calls.filter((url) => url.includes("/generate/video")).length, 1);
    assert.equal(useStore.getState().prompt, "Keep this draft");
    assert.equal(useStore.getState().generating, false);
    assert.deepEqual(useStore.getState().pendingItems, []);
  } finally {
    globalThis.fetch = fetchBefore;
    useNotices.setState({ notices: [] });
    useStore.setState(previous, true);
  }
});

test("a removed portrait refused by the server is marked and blocks the next submit until removed", async () => {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  const gone = "/api/media/uploads/portrait/removed";
  let posts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/generate/video")) posts++;
    return new Response(JSON.stringify({ error: 'Reference 2 ("R01") was removed from the Portrait Gallery.', code: "PORTRAIT_UNAVAILABLE", referenceIndex: 2 }), { status: 400 });
  };
  useNotices.setState({ notices: [] });
  useStore.setState({ mode: "video", model: "Seedance 2.5", prompt: "Keep", generating: false, batchCount: 1,
    referenceImages: ["/api/media/uploads/image-reference/a", gone], referenceKinds: ["image", "portrait"], referenceIds: ["r1", "r2"],
    referenceLabels: [], referenceTags: [], unavailableReferences: [], referenceVideos: [], items: [], pendingItems: [] });
  try {
    await useStore.getState().generate();
    assert.deepEqual(useStore.getState().unavailableReferences, [gone]);
    assert.match(useNotices.getState().notices.at(-1).text, /removed from the Portrait Gallery/);
    await useStore.getState().generate();
    assert.equal(posts, 1, "a marked reference blocks the next submit locally");
    useStore.getState().removeReference(1);
    assert.deepEqual(useStore.getState().unavailableReferences, []);
    assert.equal(useStore.getState().prompt, "Keep");
  } finally {
    globalThis.fetch = fetchBefore;
    useNotices.setState({ notices: [] });
    useStore.setState(previous, true);
  }
});

test("an audio length notice is withdrawn when the next attempt's clips are within limits", async () => {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: "Queue is busy" } }), { status: 400 });
  };
  useNotices.setState({ notices: [] });
  useStore.setState({ mode: "video", model: "Seedance 2.5", prompt: "A narrator speaks over @audio1", generating: false, batchCount: 1,
    referenceImages: [], referenceVideos: [], referenceAudios: ["/api/media/uploads/short"], audioNotes: [{ ref: "/api/media/uploads/short", duration: 1 }],
    items: [], pendingItems: [] });
  try {
    await useStore.getState().generate();
    const first = useNotices.getState().notices.map((notice) => notice.text);
    assert.equal(first.length, 1);
    assert.match(first[0], /@audio1 is .*1\.0s/);
    assert.equal(calls.filter((url) => url.includes("/generate/video")).length, 0);

    useStore.setState({ referenceAudios: ["/api/media/uploads/valid"], audioNotes: [{ ref: "/api/media/uploads/valid", duration: 2.5 }] });
    await useStore.getState().generate();
    assert.deepEqual(useNotices.getState().notices.map((notice) => notice.text), ["Queue is busy"]);
    assert.equal(calls.filter((url) => url.includes("/generate/video")).length, 1);
  } finally {
    globalThis.fetch = fetchBefore;
    useNotices.setState({ notices: [] });
    useStore.setState(previous, true);
  }
});

test("cancel patches confirmed state across loaded pools and returns provider refusal copy", async () => {
  const previous = useStore.getState(), fetchBefore = globalThis.fetch;
  const row = { id: "cancel-fixture", kind: "video", status: "running", canCancel: true };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify({ item: { ...row, status: "cancelled", canCancel: false } }), { status: 200 });
  };
  useStore.setState({ items: [row], pendingItems: [row], loadFeed: async () => {} });
  try {
    assert.deepEqual(await useStore.getState().cancelGeneration(row.id), { ok: true });
    assert.equal(useStore.getState().items[0].status, "cancelled");
    assert.equal(calls[0][0], "/api/generate/cancel");
    assert.deepEqual(JSON.parse(calls[0][1].body), { id: row.id });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Provider already started this task." }), { status: 409 });
    assert.deepEqual(await useStore.getState().cancelGeneration(row.id), { ok: false, error: "Provider already started this task." });
  } finally {
    globalThis.fetch = fetchBefore;
    useStore.setState(previous, true);
  }
});
