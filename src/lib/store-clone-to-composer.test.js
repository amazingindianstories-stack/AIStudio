import test from "node:test";
import assert from "node:assert/strict";
import { useStore } from "./store.js";

test("cloneToComposer clears staged firstFrame, lastFrame, firstFrameMode, and resets videoNotes", async () => {
  const item = {
    id: "gen-1",
    kind: "video",
    model: "seedance-25",
    prompt: "A quiet lake at dawn",
    aspectRatio: "16:9",
    resolution: "720p",
    duration: 4,
    projectId: "proj-1",
    folderId: null,
    referenceImages: [],
    referenceVideos: ["/api/media/vid-1.mp4"],
    referenceAudios: [],
  };

  useStore.setState({
    items: [item],
    firstFrame: "data:image/png;base64,AAA",
    lastFrame: "data:image/png;base64,BBB",
    firstFrameMode: true,
    videoNotes: [{ ref: "stale-1", name: "Stale 1" }, { ref: "stale-2", name: "Stale 2" }],
  });

  const res = await useStore.getState().cloneToComposer(item.id);
  assert.equal(res.ok, true);
  const state = useStore.getState();
  assert.equal(state.firstFrame, null);
  assert.equal(state.lastFrame, null);
  assert.equal(state.firstFrameMode, false);
  assert.equal(state.videoNotes.length, 1);
  assert.deepEqual(state.videoNotes[0], { ref: "/api/media/vid-1.mp4", name: "Video 1" });
});

test("regenerate with staged firstFrame does not send firstFrame or continuationFrame in POST body", async () => {
  const prevFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      status: 200,
      json: async () => ({ item: { id: "gen-2", kind: "video", status: "queued" } }),
    };
  };

  const item = {
    id: "gen-1",
    kind: "video",
    model: "seedance-25",
    prompt: "A quiet lake at dawn",
    aspectRatio: "16:9",
    resolution: "720p",
    duration: 4,
    projectId: "proj-1",
    folderId: null,
    referenceImages: [],
    referenceVideos: [],
    referenceAudios: [],
  };

  useStore.setState({
    currentUser: { id: "u1" },
    projects: [{ id: "proj-1" }],
    activeProjectId: "proj-1",
    availableModelIds: ["seedance-25"],
    availabilityAnswered: true,
    items: [item],
    firstFrame: "data:image/png;base64,AAA",
    lastFrame: "data:image/png;base64,BBB",
    firstFrameMode: true,
  });

  try {
    const res = await useStore.getState().regenerate(item.id);
    assert.equal(res?.ok, true, JSON.stringify(res));
    const genCall = calls.find((c) => c.url.includes("/api/generate/video"));
    assert.ok(genCall, `expected /api/generate/video in ${JSON.stringify(calls.map((c) => c.url))}`);
    assert.equal(genCall.body.firstFrame, undefined);
    assert.equal(genCall.body.continuationFrame, undefined);
    assert.equal(genCall.body.lastFrame, undefined);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
