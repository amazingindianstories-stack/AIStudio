import assert from "node:assert/strict";
import test from "node:test";
import { resolveSeedanceRenderControls } from "./seedance-render-controls";

test("Seedance 2.0 variants retain bitrate but discard Draft", () => {
  for (const model of ["Seedance 2.0", "Seedance 2.0 Mini"]) {
    assert.deepEqual(resolveSeedanceRenderControls(model, {}), { bitrateMode: "high" });
  }
});

test("Seedance render controls retain Draft and bitrate independently", () => {
  assert.deepEqual(resolveSeedanceRenderControls("Seedance 2.5", {}), { draftMode: false, bitrateMode: "high" });
  assert.deepEqual(resolveSeedanceRenderControls("Seedance 2.5", { draftMode: true, bitrateMode: "high" }), { draftMode: true, bitrateMode: "high" });
  assert.deepEqual(resolveSeedanceRenderControls("Seedance 2.0", { draftMode: false, bitrateMode: "standard" }), { bitrateMode: "standard" });
});

test("unsupported providers discard both render controls", () => {
  assert.deepEqual(resolveSeedanceRenderControls("Higgsfield Seedance 2.0", { draftMode: true, bitrateMode: "high" }), {});
  assert.deepEqual(resolveSeedanceRenderControls("Gemini Omni Flash", { draftMode: true, bitrateMode: "standard" }), {});
});

test("an explicitly invalid bitrate is rejected even for unsupported providers", () => {
  assert.match(resolveSeedanceRenderControls("Seedance 2.0", { bitrateMode: "ultra" }).error, /standard or high/);
  assert.match(resolveSeedanceRenderControls("Gemini Omni Flash", { bitrateMode: null }).error, /standard or high/);
});
