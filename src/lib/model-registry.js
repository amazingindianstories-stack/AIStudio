export const DEPTH_MODEL_NAME = "Depth Anything (Local)";

const IMAGE_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"];
const VIDEO_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const KLING_ASPECTS = ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"];
// GPT Image 2.5 size per aspect ratio and tier, mirroring OPENAI_IMAGE_SIZES in
// backend/apps/generation/model_registry.py (see its comment for how each size is derived).
const OPENAI_IMAGE_SIZES = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "2880x2880" },
  "3:4": { "1K": "864x1152", "2K": "1536x2048", "4K": "2448x3264" },
  "4:3": { "1K": "1152x864", "2K": "2048x1536", "4K": "3264x2448" },
  "4:5": { "1K": "896x1120", "2K": "1664x2080", "4K": "2560x3200" },
  "5:4": { "1K": "1120x896", "2K": "2080x1664", "4K": "3200x2560" },
  "2:3": { "1K": "1024x1536", "2K": "1376x2064", "4K": "2336x3504" },
  "3:2": { "1K": "1536x1024", "2K": "2064x1376", "4K": "3504x2336" },
  "9:16": { "1K": "720x1280", "2K": "1152x2048", "4K": "2160x3840" },
  "16:9": { "1K": "1280x720", "2K": "2048x1152", "4K": "3840x2160" },
  "21:9": { "1K": "1568x672", "2K": "2016x864", "4K": "3808x1632" },
};
const OPENAI_IMAGE_CAPABILITIES = {
  aspectRatios: Object.keys(OPENAI_IMAGE_SIZES),
  resolutions: ["1K", "2K", "4K"],
  imageSizes: OPENAI_IMAGE_SIZES,
  // OpenAI calls outputs above 2560x1440 pixels experimental.
  experimentalAbovePixels: 2560 * 1440,
  maxReferenceImages: 16,
  qualities: ["low", "medium", "high", "xhigh", "max"],
  qualityPriceFactors: { low: 0.03, medium: 0.25, high: 1, xhigh: 2, max: 4 },
  backgrounds: ["opaque", "transparent"],
  seed: false,
};
// 2.6 only offers the three documented standard raster sizes, mirrored in Python.
const OPENAI_IMAGE_26_SIZES = {
  "1:1": { "1K": "1024x1024" }, "3:2": { "1K": "1536x1024" }, "2:3": { "1K": "1024x1536" },
};
const OPENAI_IMAGE_26_CAPABILITIES = {
  aspectRatios: Object.keys(OPENAI_IMAGE_26_SIZES), resolutions: ["1K"], imageSizes: OPENAI_IMAGE_26_SIZES,
  maxReferenceImages: 16, qualities: ["low", "medium", "high", "xhigh", "max"],
  qualityPriceFactors: { low: 0.03, medium: 0.25, high: 1, xhigh: 2, max: 4 },
  backgrounds: ["opaque", "transparent"], seed: false,
};
const SEEDANCE_20_DURATIONS = [4, 5, 8, 10, 15];
const HIGGSFIELD_DURATIONS = [3, 4, 5, 6, 8, 10, 12];

/**
 * Stable model metadata. Display names remain accepted as historical aliases,
 * but routing, pricing, and capabilities are explicit data rather than regexes.
 */
export const MODEL_REGISTRY = [
  {
    id: "seedream-5-pro", name: "Seedream 5.0 Pro", kind: "image", provider: "seedream",
    providerModelId: "dola-seedream-5-0-pro-260628", providerModelEnv: "SEEDREAM_MODEL",
    offered: true, badge: "NEW", hint: "Precise editing with up to 10 original references · 1K/1.5K/2K PNG",
    pricingKey: "Seedream 5.0 Pro",
    capabilities: { aspectRatios: IMAGE_ASPECTS, resolutions: ["1K", "1.5K", "2K"], maxReferenceImages: 10, seed: false, imagePriceScalesWithResolution: false },
  },
  {
    id: "seedream-5-5", name: "Seedream 5.5", kind: "image", provider: "seedream",
    providerModelId: "dola-seedream-5-5-261028", providerModelEnv: "SEEDREAM_55_MODEL",
    offered: true, badge: "NEW", hint: "Consistent multi-turn edits, native transparent PNG · up to 10 references · 1K/1.5K/2K",
    pricingKey: "Seedream 5.5",
    capabilities: {
      aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"], resolutions: ["1K", "1.5K", "2K"],
      maxReferenceImages: 10, backgrounds: ["opaque", "transparent"], layerDecomposition: { minImages: 2, maxImages: 100, defaultImages: 30 }, seed: false, imagePriceScalesWithResolution: false,
    },
  },
  {
    id: "nano-banana-pro",
    name: "Nano Banana Pro",
    kind: "image",
    provider: "gemini",
    providerModelId: "gemini-3-pro-image",
    offered: true,
    badge: "BEST",
    pricingKey: "Nano Banana Pro",
    capabilities: { aspectRatios: IMAGE_ASPECTS, resolutions: ["1K", "2K", "4K"], seed: true },
  },
  {
    // ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1 (read 2026-10-16): 1K/2K/4K
    // output (no 512px), up to 14 reference images, same generateContent imageConfig as Pro.
    id: "nano-banana-2-1",
    name: "Nano Banana 2.1",
    kind: "image",
    provider: "gemini",
    providerModelId: "gemini-nano-banana-2.1",
    offered: true,
    badge: "FAST",
    hint: "Flash-speed Gemini image · up to 14 references · 1K/2K/4K",
    pricingKey: "Nano Banana 2.1",
    capabilities: {
      aspectRatios: ["1:1", "3:4", "4:3", "4:5", "5:4", "2:3", "3:2", "9:16", "16:9", "21:9"],
      resolutions: ["1K", "2K", "4K"],
      maxReferenceImages: 14,
      seed: true,
    },
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
    hint: "Strong prompt adherence, 1K/2K - takes a single reference image",
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
    hint: "Cheapest text-to-image here (~$0.014) - 2K only without a reference",
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
    // developers.openai.com/api/docs/models/gpt-image-2.5-sunburst and -flare (read 2026-11-04): pinned
    // snapshots, Images API generations/edits, up to 16 reference images, billed per token.
    id: "gpt-image-2-5-sunburst",
    name: "GPT Image 2.5 Sunburst",
    kind: "image",
    provider: "openai",
    providerModelId: "gpt-image-2.5-sunburst-2026-09-08",
    offered: true,
    badge: "NEW",
    hint: "OpenAI's most capable image model, precise edits · up to 16 references · 1K/2K/4K PNG",
    pricingKey: "GPT Image 2.5 Sunburst",
    capabilities: OPENAI_IMAGE_CAPABILITIES,
  },
  {
    id: "gpt-image-2-5-flare",
    name: "GPT Image 2.5 Flare",
    kind: "image",
    provider: "openai",
    providerModelId: "gpt-image-2.5-flare-2026-09-08",
    offered: true,
    badge: "FAST",
    hint: "Fast everyday OpenAI image model · up to 16 references · 1K/2K/4K PNG",
    pricingKey: "GPT Image 2.5 Flare",
    capabilities: OPENAI_IMAGE_CAPABILITIES,
  },
  {
    // Official sources read 2026-11-12:
    // https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst
    // https://developers.openai.com/api/docs/models/gpt-image-2.6-flare
    // https://developers.openai.com/api/reference/resources/images/methods/generate
    // https://developers.openai.com/api/docs/guides/image-generation
    // https://developers.openai.com/api/docs/pricing
    // OpenAI publishes no dated snapshot for 2.6; pin these documented model strings without inventing one.
    // Same Images API generations/edits, five qualities, opaque/transparent PNG, standard sizes only.
    // Omit complexity (provider default high); SVG/GIF/markup are outside this raster integration.
    // Per 1M tokens: text $5 (cached $1.25), image input $8 (cached $2), image output $30.
    id: "gpt-image-2-6-sunburst",
    name: "GPT Image 2.6 Sunburst",
    kind: "image",
    provider: "openai",
    providerModelId: "gpt-image-2.6-sunburst",
    offered: true,
    badge: "NEW",
    hint: "Detailed visual work and precise edits · up to 16 references · standard sizes PNG",
    pricingKey: "GPT Image 2.6 Sunburst",
    capabilities: OPENAI_IMAGE_26_CAPABILITIES,
  },
  {
    id: "gpt-image-2-6-flare",
    name: "GPT Image 2.6 Flare",
    kind: "image",
    provider: "openai",
    providerModelId: "gpt-image-2.6-flare",
    offered: true,
    badge: "FAST",
    hint: "Fast everyday OpenAI image model · up to 16 references · standard sizes PNG",
    pricingKey: "GPT Image 2.6 Flare",
    capabilities: OPENAI_IMAGE_26_CAPABILITIES,
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
      // BytePlus limits per audio_url clip and per request; the provider rejects longer clips.
      referenceAudioSeconds: { clipMin: 2, clipMax: 15, totalMax: 15 },
      bitrate: true,
      seed: true,
      videoBestOf: true,
      firstFrameContinuation: true,
      firstLastFrame: true,
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
      referenceAudioSeconds: { clipMin: 2, clipMax: 15, totalMax: 15 },
      bitrate: true,
      seed: true,
      videoBestOf: true,
      firstFrameContinuation: true,
      firstLastFrame: true,
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
      maxReferenceVideos: 10,
      videoReference: true,
      audio: true,
      referenceAudioSeconds: { clipMin: 2, clipMax: 30, totalMax: 30 },
      draft: true,
      bitrate: true,
      editExtend: true,
      seed: true,
      videoBestOf: true,
      firstFrameContinuation: true,
      firstLastFrame: true,
    },
  },
  {
    id: "omnihuman-2", name: "OmniHuman 2.0", kind: "video", provider: "omnihuman",
    providerModelId: "realman_avatar_picture_omni20_cv", offered: true, badge: "NEW",
    hint: "BytePlus Vision - one image plus WAV/MP3 audio, 4-300s; output length and framing follow the inputs",
    pricingKey: "OmniHuman 2.0",
    capabilities: {
      aspectRatios: ["Auto"], resolutions: ["Auto"], durations: [4, 5, 10, 30, 60, 120, 300],
      durationRange: { min: 4, max: 300, step: 1 }, maxReferenceImages: 1, maxReferenceAudios: 1, audio: true, inputDrivenVideo: true,
      referenceAudioSeconds: { clipMin: 4, clipMax: 300, totalMax: 300, slackSeconds: 0 }, resolutionPriceFactors: { Auto: 1 },
    },
  },
  {
    // ai.google.dev/gemini-api/docs/models/gemini-omni-flash and /docs/omni (read 2026-10-18): stable
    // model code, output 3-10s, 16:9/9:16, 360p/720p (1080p/4k are upscaled and their price is not
    // published in text, so they are not offered). Audio comes from the prompt; there is no audio field.
    id: "gemini-omni-1-1-flash",
    name: "Gemini Omni Flash 1.1",
    kind: "video",
    provider: "omni",
    providerModelId: "gemini-omni-1.1-flash",
    offered: true,
    badge: "NEW",
    hint: "Google Interactions API · 360p draft or 720p · 4-10s · 16:9/9:16 · sound from the prompt",
    pricingKey: "Gemini Omni Flash 1.1",
    capabilities: { aspectRatios: ["16:9", "9:16"], resolutions: ["360p", "720p"], durations: [4, 6, 8, 10] },
  },
  {
    // Retired: Google shuts gemini-omni-flash-preview down on 2026-10-22. Kept so history keeps
    // its label; the composer moves its settings to the replacement and the server refuses new jobs.
    id: "gemini-omni-flash",
    name: "Gemini Omni Flash",
    kind: "video",
    provider: "omni",
    providerModelId: "gemini-omni-flash-preview",
    offered: false,
    retiredFor: "gemini-omni-1-1-flash",
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
    id: "magnific-creative",
    name: "Magnific Creative",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "AI UPSCALE",
    hint: "Prompt-guided detail hallucination & stylization · 2x/4x/8x/16x",
    pricingKey: "Magnific Creative",
    capabilities: {
      scaleFactors: ["2x", "4x", "8x", "16x"],
      aspectRatios: [],
      resolutions: [],
    },
  },
  {
    id: "magnific-precision-v2",
    name: "Magnific Precision V2",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "PRECISE V2",
    hint: "High-fidelity super-resolution with sharpen, grain, & ultra-detail controls · 2x–16x",
    pricingKey: "Magnific Precision V2",
    capabilities: {
      scaleFactors: ["2x", "4x", "8x", "16x"],
      aspectRatios: [],
      resolutions: [],
    },
  },
  {
    id: "magnific-precision-v1",
    name: "Magnific Precision V1",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "PRECISE V1",
    hint: "Faithful 2x super-resolution without hallucinations · Best for UI, text, & logos",
    pricingKey: "Magnific Precision V1",
    capabilities: {
      scaleFactors: ["2x"],
      aspectRatios: [],
      resolutions: [],
    },
  },
  {
    id: "magnific-video-creative",
    name: "Magnific Video Creative",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "VIDEO UPSCALE",
    hint: "Creative video upscaling with creativity, sharpen and grain · 720p–4K",
    pricingKey: "Magnific Video Creative",
    capabilities: { upscaleMedia: "video", resolutions: ["720p", "1k", "2k", "4k"], aspectRatios: [] },
  },
  {
    id: "magnific-video-creative-turbo",
    name: "Magnific Video Creative Turbo",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "TURBO",
    hint: "Faster Creative video upscaling · 720p–4K",
    pricingKey: "Magnific Video Creative Turbo",
    capabilities: { upscaleMedia: "video", resolutions: ["720p", "1k", "2k", "4k"], aspectRatios: [] },
  },
  {
    id: "magnific-video-precision",
    name: "Magnific Video Precision",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "PRECISION",
    hint: "Faithful video upscaling with strength, sharpen and grain · 720p–4K",
    pricingKey: "Magnific Video Precision",
    capabilities: { upscaleMedia: "video", resolutions: ["720p", "1k", "2k", "4k"], aspectRatios: [] },
  },
  {
    id: "magnific-video-topaz",
    name: "Magnific Video Topaz",
    kind: "upscale",
    provider: "magnific",
    offered: true,
    badge: "TOPAZ",
    hint: "Topaz Starlight enhancement with optional frame interpolation · 720p–4K",
    pricingKey: "Magnific Video Topaz",
    capabilities: { upscaleMedia: "video", resolutions: ["720p", "1k", "2k", "4k"], aspectRatios: [] },
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

/**
 * Whether a new job may use `name` right now. `availableIds` is the server's answer
 * (`availability.models` on GET /api/auth/me, registry ids, derived from the same backend
 * switches as the enqueue refusal); null while unknown, when every offered model counts and
 * the enqueue refusal stays the authority.
 */
export function isModelAvailable(name, availableIds = null) {
  const model = getModelDefinition(name);
  if (!model?.offered || model.retiredFor) return false;
  return !Array.isArray(availableIds) || availableIds.includes(model.id);
}

/** The picker entries for new jobs: offered models, less any the server reports switched off. */
export function availableModels(availableIds = null) {
  return offeredModels().filter((model) => isModelAvailable(model.id, availableIds));
}

/** The model a composer should use for `name`: a retired model's replacement, otherwise `name`. */
export function composerModel(name) {
  const retiredFor = getModelDefinition(name)?.retiredFor;
  return retiredFor ? getModelDefinition(retiredFor).name : name;
}

export function capability(name, key, fallback = false) {
  return getModelDefinition(name)?.capabilities?.[key] ?? fallback;
}
