import assert from "node:assert/strict";
import test from "node:test";
import { restoreComposerDraft, useStore } from "./store";

test("composer render controls default to Final and High", () => {
  const state = useStore.getState();
  assert.equal(state.draftMode, false);
  assert.equal(state.bitrateMode, "high");
});

test("image/video defaults are 21:9 and supported video audio defaults on", () => {
  useStore.getState().setMode("image");
  assert.equal(useStore.getState().aspectRatio, "21:9");
  useStore.getState().setMode("video");
  assert.equal(useStore.getState().aspectRatio, "21:9");
  assert.equal(useStore.getState().generateAudio, true);
});

test("returning from a constrained video provider restores 21:9 and audio on", () => {
  useStore.setState({ mode: "video", model: "Gemini Omni Flash", aspectRatio: "16:9", generateAudio: false });
  useStore.getState().setModel("Seedance 2.0");
  assert.equal(useStore.getState().aspectRatio, "21:9");
  assert.equal(useStore.getState().generateAudio, true);
});

test("switching to an unsupported provider resets render controls", () => {
  useStore.setState({ mode: "video", model: "Seedance 2.0", draftMode: true, bitrateMode: "standard" });
  useStore.getState().setModel("Gemini Omni Flash");
  assert.equal(useStore.getState().draftMode, false);
  assert.equal(useStore.getState().bitrateMode, "high");
});

test("local composer restoration keeps supported Draft and bitrate", () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map([
    ["veevee-draft-settings-v1", JSON.stringify({ mode: "video", model: "Seedance 2.5", draftMode: true, bitrateMode: "standard" })],
  ]);
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    useStore.setState({ prompt: "", referenceImages: [], draftMode: false, bitrateMode: "high" });
    restoreComposerDraft();
    assert.equal(useStore.getState().draftMode, true);
    assert.equal(useStore.getState().bitrateMode, "standard");

    values.set("veevee-draft-settings-v1", JSON.stringify({ mode: "video", model: "Gemini Omni Flash", draftMode: true, bitrateMode: "standard" }));
    restoreComposerDraft();
    assert.equal(useStore.getState().draftMode, false);
    assert.equal(useStore.getState().bitrateMode, "high");
  } finally {
    globalThis.localStorage = previousStorage;
  }
});

test("cloneToComposer restores supported stored settings and gives legacy rows safe defaults", async () => {
  const current = useStore.getState();
  const supported = { id: "supported", kind: "video", status: "succeeded", prompt: "scene", model: "Seedance 2.5", aspectRatio: "21:9", resolution: "720p", duration: 5, draftMode: true, bitrateMode: "standard" };
  useStore.setState({ items: [supported], threadItems: [], pendingItems: [] });
  assert.deepEqual(await current.cloneToComposer("supported"), { ok: true });
  assert.equal(useStore.getState().draftMode, true);
  assert.equal(useStore.getState().bitrateMode, "standard");

  const modern = { id: "modern", kind: "video", status: "succeeded", prompt: "scene", model: "Seedance 2.0", aspectRatio: "16:9", resolution: "720p", duration: 5, draftMode: true, bitrateMode: "standard" };
  useStore.setState({ items: [modern], threadItems: [], pendingItems: [] });
  assert.deepEqual(await current.cloneToComposer("modern"), { ok: true });
  assert.equal(useStore.getState().draftMode, false);
  assert.equal(useStore.getState().bitrateMode, "standard");

  const legacy = { ...modern, id: "legacy", draftMode: undefined, bitrateMode: undefined };
  useStore.setState({ items: [legacy] });
  assert.deepEqual(await useStore.getState().cloneToComposer("legacy"), { ok: true });
  assert.equal(useStore.getState().draftMode, false);
  assert.equal(useStore.getState().bitrateMode, "high");
});
