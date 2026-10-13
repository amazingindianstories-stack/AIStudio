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
