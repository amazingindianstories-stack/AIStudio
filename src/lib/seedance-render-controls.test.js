import assert from "node:assert/strict";
import test from "node:test";
import { resolveSeedanceRenderControls } from "./seedance-render-controls";

test("direct BytePlus requests receive explicit render defaults", () => {
  for (const model of ["Seedance 2.0", "Seedance 2.0 Mini", "Seedance 2.5"]) {
    assert.deepEqual(resolveSeedanceRenderControls(model, {}), {
      draftMode: false,
      bitrateMode: "high",
    });
  }
});

test("selected render settings are retained independently", () => {
  assert.deepEqual(resolveSeedanceRenderControls("Seedance 2.5", { draftMode: true, bitrateMode: "high" }), { draftMode: true, bitrateMode: "high" });
  assert.deepEqual(resolveSeedanceRenderControls("Seedance 2.0", { draftMode: false, bitrateMode: "standard" }), { draftMode: false, bitrateMode: "standard" });
});

test("unsupported providers discard both render controls", () => {
  assert.deepEqual(resolveSeedanceRenderControls("Higgsfield Seedance 2.0", { draftMode: true, bitrateMode: "high" }), {});
  assert.deepEqual(resolveSeedanceRenderControls("Gemini Omni Flash", { draftMode: true, bitrateMode: "standard" }), {});
});

test("an explicitly invalid bitrate is rejected even for unsupported providers", () => {
  assert.match(resolveSeedanceRenderControls("Seedance 2.0", { bitrateMode: "ultra" }).error, /standard or high/);
  assert.match(resolveSeedanceRenderControls("Gemini Omni Flash", { bitrateMode: null }).error, /standard or high/);
});
