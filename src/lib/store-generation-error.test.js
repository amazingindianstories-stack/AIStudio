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
