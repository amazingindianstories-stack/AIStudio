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

