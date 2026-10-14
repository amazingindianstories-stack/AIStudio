// Display choices and browser form serialization only. Provider execution lives in Django.
export const MAGNIFIC_MODELS = ["Magnific Creative", "Magnific Precision V2", "Magnific Precision V1"];

export const MAGNIFIC_CREATIVE_PRESETS = [
  { id: "standard", label: "Standard" },
  { id: "soft_portraits", label: "Soft Portraits" },
  { id: "hard_portraits", label: "Hard Portraits" },
  { id: "art_n_illustration", label: "Art & Illustration" },
  { id: "videogame_assets", label: "Videogame Assets" },
  { id: "nature_n_landscapes", label: "Nature & Landscapes" },
  { id: "films_n_photography", label: "Films & Photography" },
  { id: "3d_renders", label: "3D Renders" },
  { id: "science_fiction_n_horror", label: "Sci-Fi & Horror" },
];

export const MAGNIFIC_ENGINES = [
  { id: "automatic", label: "Automatic" },
  { id: "magnific_illusio", label: "Illusio" },
  { id: "magnific_sharpy", label: "Sharpy" },
  { id: "magnific_sparkle", label: "Sparkle" },
];

export const MAGNIFIC_PRECISION_FLAVORS = [
  { id: "photo", label: "Photo (Realistic Details)" },
  { id: "sublime", label: "Sublime (Illustrations & Art)" },
  { id: "photo_denoiser", label: "Photo Denoiser (Low-Light & Grainy)" },
];

export const MAGNIFIC_SCALE_FACTORS = ["2x", "4x", "8x", "16x"];

export function magnificParamsForModel(model, params) {
  const common = { model, filterNsfw: Boolean(params.filterNsfw) };
  if (model === "Magnific Creative") return { ...common, scaleFactor: params.scaleFactor, prompt: params.prompt, optimizedFor: params.optimizedFor, engine: params.engine, creativity: params.creativity, hdr: params.hdr, resemblance: params.resemblance, fractality: params.fractality };
  if (model === "Magnific Precision V2") return { ...common, scaleFactor: params.scaleFactor, flavor: params.flavor, sharpen: params.sharpen, smartGrain: params.smartGrain, ultraDetail: params.ultraDetail };
  if (model === "Magnific Precision V1") return { ...common, sharpen: params.sharpen, smartGrain: params.smartGrain, ultraDetail: params.ultraDetail };
  throw new Error("Unsupported Magnific model.");
}

export function isMagnificModel(model) {
  return MAGNIFIC_MODELS.includes(model);
}


// Video upscalers (docs.magnific.com/api-reference/video/*). Django validates
// the same ranges and records the per-frame estimate when the job is queued.
export const MAGNIFIC_VIDEO_MODELS = [
  "Magnific Video Creative",
  "Magnific Video Creative Turbo",
  "Magnific Video Precision",
  "Magnific Video Topaz",
];
export const MAGNIFIC_VIDEO_RESOLUTIONS = ["720p", "1k", "2k", "4k"];
export const MAGNIFIC_VIDEO_FLAVORS = [
  { id: "vivid", label: "Vivid" },
  { id: "natural", label: "Natural" },
];
export const MAGNIFIC_VIDEO_OUTPUT_FORMATS = [
  { id: "h264", label: "H.264 MP4" },
  { id: "prores_422_hq", label: "ProRes 422 HQ MOV" },
];
export const MAGNIFIC_TOPAZ_MODELS = [
  { id: "starlight_precise_2_5", label: "Starlight Precise 2.5" },
  { id: "starlight_fast_2", label: "Starlight Fast 2" },
];
export const MAGNIFIC_TOPAZ_INTERPOLATIONS = [
  { id: "apollo", label: "Apollo" },
  { id: "chronos", label: "Chronos (slow motion)" },
];
export const MAGNIFIC_VIDEO_DEFAULTS = {
  model: "Magnific Video Creative",
  resolution: "2k",
  creativity: 0,
  sharpen: 0,
  smartGrain: 0,
  strength: 60,
  fpsBoost: false,
  flavor: "vivid",
  outputFormat: "h264",
  enhancementModel: "starlight_precise_2_5",
  targetFps: null,
  frameInterpolation: "apollo",
  noise: 0,
};
export const MAGNIFIC_VIDEO_MAX_SECONDS = 60;

export function magnificVideoParamsForModel(model, params) {
  if (model === "Magnific Video Creative" || model === "Magnific Video Creative Turbo") {
    return { model, resolution: params.resolution, creativity: params.creativity, sharpen: params.sharpen, smartGrain: params.smartGrain, fpsBoost: Boolean(params.fpsBoost), flavor: params.flavor, outputFormat: params.outputFormat };
  }
  if (model === "Magnific Video Precision") {
    return { model, resolution: params.resolution, sharpen: params.sharpen, smartGrain: params.smartGrain, strength: params.strength, fpsBoost: Boolean(params.fpsBoost), outputFormat: params.outputFormat };
  }
  if (model === "Magnific Video Topaz") {
    // Docs: frame_interpolation only applies when target_fps changes the rate (>= 15 fps).
    const result = { model, resolution: params.resolution, enhancementModel: params.enhancementModel, noise: params.noise };
    if (params.targetFps) Object.assign(result, { targetFps: params.targetFps, frameInterpolation: params.frameInterpolation });
    return result;
  }
  throw new Error("Unsupported Magnific video model.");
}
