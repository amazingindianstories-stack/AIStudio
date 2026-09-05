export const DEPTH_MODEL_NAME = "Depth Anything (Local)";

const IMAGE_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"];
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const KLING_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"];
const SEEDANCE_20_DURATIONS = [4, 5, 8, 10, 15];
const HIGGSFIELD_DURATIONS = [3, 4, 5, 6, 8, 10, 12];

/**
 * Stable model metadata. Display names remain accepted as historical aliases,
 * but routing, pricing, and capabilities are explicit data rather than regexes.
 */
export const MODEL_REGISTRY = [
  {
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    kind: "image",
    provider: "gemini",
    offered: true,
    badge: "BEST",
    pricingKey: "Nano Banana Pro",
    capabilities: { aspectRatios: IMAGE_ASPECTS, resolutions: ["1K", "2K", "4K"], seed: true },
  },
  {
    id: "nano-banana-2",
    name: "Nano Banana 2",
    kind: "image",
    provider: "gemini",
    offered: false,
    pricingKey: "Nano Banana 2",
    capabilities: { aspectRatios: IMAGE_ASPECTS, resolutions: ["1K", "2K", "4K"], seed: true },
  },
  {
    id: "kling-image-3",
    name: "Kling Image 3.0",
    kind: "image",
    provider: "kling",
    providerModelId: "kling-v3",
    offered: true,
    badge: "NEW",
    hint: "Strong prompt adherence, 1K/2K — takes a single reference image",
    pricingKey: "Kling Image 3.0",
    capabilities: {
      aspectRatios: KLING_ASPECTS,
      resolutions: ["1K", "2K"],
      referenceResolutions: ["1K", "2K"],
      maxReferenceImages: 1,
      imagePriceScalesWithResolution: false,
    },
  },
  {
    id: "kling-image-21",
    name: "Kling Image 2.1",
    kind: "image",
    provider: "kling",
    providerModelId: "kling-v2-1",
    offered: true,
    badge: "BUDGET",
    hint: "Cheapest text-to-image here (~$0.014) — 2K only without a reference",
    pricingKey: "Kling Image 2.1",
    imageToImagePricingKey: "Kling Image 2.1 · image-to-image",
    capabilities: {
      aspectRatios: KLING_ASPECTS,
      resolutions: ["1K", "2K"],
      referenceResolutions: ["1K"],
      maxReferenceImages: 1,
      imagePriceScalesWithResolution: false,
    },
  },
  {
    id: "seedance",
    name: "Seedance 2.0",
    kind: "video",
    provider: "byteplus",
    providerModelId: "dreamina-seedance-2-0-260128",
    providerModelEnv: "SEEDANCE_MODEL",
    offered: true,
    badge: "DIRECT",
    hint: "BytePlus ModelArk direct — up to 9 reference images; its content filter rejects photorealistic faces",
    pricingKey: "Seedance 2.0",
    audioPricingKey: "Seedance 2.0 · audio",
    capabilities: {
      aspectRatios: VIDEO_ASPECTS,
      resolutions: ["480p", "720p", "1080p"],
      durations: SEEDANCE_20_DURATIONS,
      durationRange: { min: 4, max: 15, step: 1 },
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      videoReference: true,
      audio: true,
      seed: true,
      videoBestOf: true,
      firstFrameContinuation: true,
    },
  },
  {
    id: "seedance-20-mini",
    name: "Seedance 2.0 Mini",
    kind: "video",
    provider: "byteplus",
    providerModelId: "dreamina-seedance-2-0-fast-260128",
    providerModelEnv: "SEEDANCE_MODEL_FAST",
    offered: false,
    pricingKey: "Seedance 2.0 Mini",
    audioPricingKey: "Seedance 2.0 Mini · audio",
    capabilities: {
      aspectRatios: VIDEO_ASPECTS,
      resolutions: ["480p", "720p"],
      durations: SEEDANCE_20_DURATIONS,
      durationRange: { min: 4, max: 15, step: 1 },
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      videoReference: true,
      audio: true,
      seed: true,
      videoBestOf: true,
      firstFrameContinuation: true,
    },
  },
  {
    id: "seedance-25",
    name: "Seedance 2.5",
    kind: "video",
    provider: "byteplus",
    providerModelId: "dreamina-seedance-2-5-260628",
    providerModelEnv: "SEEDANCE_MODEL_25",
    offered: true,
    badge: "NEW",
    hint: "BytePlus ModelArk direct — 480p/720p/1080p, up to 30s; can edit or extend an attached clip",
    pricingKey: "Seedance 2.5",
    tokenPricingKey: "Seedance 2.5 · per-token",
    videoInputTokenPricingKey: "Seedance 2.5 · per-token (video input)",
    usageCost: "seedance-token",
    capabilities: {
      aspectRatios: VIDEO_ASPECTS,
      resolutions: ["480p", "720p", "1080p"],
      durations: [4, 5, 8, 10, 15, 20, 25, 30],
      durationRange: { min: 4, max: 30, step: 1 },
      maxReferenceImages: 30,
      maxReferenceVideos: 3,
      videoReference: true,
      audio: true,
      editExtend: true,
      seed: true,
      videoBestOf: true,
      firstFrameContinuation: true,
    },
  },
  {
    id: "gemini-omni-flash",
    name: "Gemini Omni Flash",
    kind: "video",
    provider: "omni",
    providerModelId: "gemini-omni-flash-preview",
    providerModelEnv: "OMNI_MODEL",
    offered: true,
    badge: "NEW",
    hint: "Google Interactions API — full NBP-style reference scaffolding, 16:9/9:16 only",
    pricingKey: "Gemini Omni Flash",
    capabilities: { aspectRatios: ["16:9", "9:16"], resolutions: ["720p"], durations: [4, 6, 8] },
  },
  {
    id: "depth-anything-local",
    name: DEPTH_MODEL_NAME,
    kind: "depth",
    provider: "local-depth",
    offered: true,
    badge: "LOCAL",
    hint: "Runs on a local worker machine, not the cloud — offline if nobody's machine is running it",
    capabilities: { aspectRatios: [], resolutions: [] },
  },
  {
    id: "higgsfield-nano-banana-pro",
    name: "Higgsfield Nano Banana Pro",
    kind: "image",
    provider: "higgsfield",
    providerModelId: "nano_banana_pro",
    higgsfieldTool: "nano-banana",
    offered: false,
    pricingKey: "Higgsfield Nano Banana Pro",
    capabilities: { aspectRatios: IMAGE_ASPECTS, resolutions: ["1K", "2K", "4K"] },
  },
  {
    id: "higgsfield-soul",
    name: "Higgsfield Soul",
    kind: "image",
    provider: "higgsfield",
    providerModelId: "soul_2",
    higgsfieldTool: "soul",
    offered: false,
    pricingKey: "Higgsfield Soul",
    capabilities: { aspectRatios: IMAGE_ASPECTS, resolutions: ["1K", "2K"] },
  },
  {
    id: "higgsfield-seedance-20",
    name: "Higgsfield Seedance 2.0",
    kind: "video",
    provider: "higgsfield",
    providerModelId: "seedance_2_0",
    higgsfieldTool: "video",
    offered: false,
    pricingKey: "Higgsfield Seedance 2.0",
    capabilities: {
      aspectRatios: VIDEO_ASPECTS,
      resolutions: ["480p", "720p", "1080p"],
      durations: HIGGSFIELD_DURATIONS,
      maxReferenceImages: 9,
    },
  },
  {
    id: "higgsfield-seedance-20-mini",
    name: "Higgsfield Seedance 2.0 Mini",
    kind: "video",
    provider: "higgsfield",
    providerModelId: "seedance_2_0_mini",
    higgsfieldTool: "video",
    offered: false,
    pricingKey: "Higgsfield Seedance 2.0 Mini",
    capabilities: {
      aspectRatios: VIDEO_ASPECTS,
      resolutions: ["480p", "720p"],
      durations: HIGGSFIELD_DURATIONS,
      maxReferenceImages: 9,
    },
  },
];

const byName = new Map(MODEL_REGISTRY.map((model) => [model.name.toLowerCase(), model]));
const byId = new Map(MODEL_REGISTRY.map((model) => [model.id, model]));

export function getModelDefinition(nameOrId) {
  if (!nameOrId) return null;
  const key = String(nameOrId).trim();
  return byId.get(key) ?? byName.get(key.toLowerCase()) ?? null;
}

export function modelsForProvider(provider) {
  return MODEL_REGISTRY.filter((model) => model.provider === provider);
}

export function isProviderModel(name, provider) {
  return getModelDefinition(name)?.provider === provider;
}

export function providerModelId(name, env = process.env) {
  const model = getModelDefinition(name);
  if (!model) return undefined;
  return (model.providerModelEnv && env[model.providerModelEnv]) || model.providerModelId;
}

export function offeredModels() {
  return MODEL_REGISTRY.filter((model) => model.offered).map(
    ({ id, name, kind, badge, hint }) => ({ id, name, kind, badge, hint })
  );
}

export function capability(name, key, fallback = false) {
  return getModelDefinition(name)?.capabilities?.[key] ?? fallback;
}
