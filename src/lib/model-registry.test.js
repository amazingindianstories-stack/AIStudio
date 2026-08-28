import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_PRICING } from "./pricing.js";
import {
  MODEL_REGISTRY,
  capability,
  getModelDefinition,
  offeredModels,
  providerModelId,
} from "./model-registry.js";

test("model registry ids and names are unique and case-insensitive", () => {
  assert.equal(new Set(MODEL_REGISTRY.map((m) => m.id)).size, MODEL_REGISTRY.length);
  assert.equal(new Set(MODEL_REGISTRY.map((m) => m.name.toLowerCase())).size, MODEL_REGISTRY.length);
  assert.equal(getModelDefinition("SEEDANCE 2.5")?.id, "seedance-25");
});

test("every offered paid model has an explicit pricing row", () => {
  const pricing = new Set(DEFAULT_PRICING.map((row) => row.model));
  for (const model of offeredModels()) {
    const definition = getModelDefinition(model.id);
    if (definition.provider === "local-depth") continue;
    assert.ok(definition.pricingKey, `${model.name} lacks pricingKey`);
    assert.ok(pricing.has(definition.pricingKey), `${model.name} lacks pricing row`);
  }
});

test("legacy models remain routable without returning to the picker", () => {
  const offered = new Set(offeredModels().map((model) => model.name));
  for (const name of ["Seedance 2.0 Mini", "Higgsfield Seedance 2.0", "Higgsfield Soul"]) {
    assert.ok(getModelDefinition(name));
    assert.equal(offered.has(name), false);
  }
});

test("capabilities and provider ids are explicit with safe unknown defaults", () => {
  assert.equal(capability("Seedance 2.5", "maxReferenceImages"), 30);
  assert.equal(capability("Higgsfield Seedance 2.0", "audio"), false);
  assert.equal(capability("unknown future model", "audio"), false);
  assert.equal(providerModelId("Seedance 2.5", { SEEDANCE_MODEL_25: "override-25" }), "override-25");
  assert.equal(providerModelId("unknown future model"), undefined);
});

test("critical routing and capability files do not regress to display-name regexes", async () => {
  const files = [
    "src/lib/config.js",
    "src/lib/pricing.js",
    "src/lib/store-db.js",
    "src/components/ComposerControls.jsx",
    "src/components/PromptComposer.jsx",
    "src/app/api/queue/execute/route.js",
    "src/app/api/generate/video/route.js",
    "src/app/api/generate/video/status/route.js",
  ];
  const forbidden = [
    /\/higgsfield\/i\.test/,
    /\/omni\/i\.test/,
    /\/seedance[^\n]*\/i\.test/,
    /\/nano banana\/i\.test/,
    /\/\^?kling[^\n]*\/i\.test/,
    /ilike\s+'%omni%'/i,
  ];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must use model-registry metadata`);
    }
  }
});
