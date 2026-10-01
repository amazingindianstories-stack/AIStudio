/**
 * Magnific AI Upscaler Provider.
 * Supports:
 * - Upscaler Creative (POST /v1/ai/image-upscaler)
 * - Upscaler Precision V1 (POST /v1/ai/image-upscaler-precision)
 * - Upscaler Precision V2 (POST /v1/ai/image-upscaler-precision-v2)
 */

export const MAGNIFIC_BASE_URL = "https://api.magnific.com";
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

export function resolveMagnificVariant(model) {
  if (model === "Magnific Creative") return "creative";
  if (model === "Magnific Precision V1") return "precision-v1";
  if (model === "Magnific Precision V2") return "precision-v2";
  throw new Error("Unsupported Magnific model.");
}

function getApiKey(apiKey) {
  return apiKey || process.env.MAGNIFIC_API_KEY;
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * Shape payload and endpoint for Magnific upscaling
 */
export function buildMagnificPayload(variant, { image, params = {} }) {
  if (!image || typeof image !== "string") {
    throw new Error("A valid source image (data URI or public URL) is required.");
  }

  // Ensure data URI or URL format
  let formattedImage = image.trim();
  if (!formattedImage.startsWith("data:") && !formattedImage.startsWith("http://") && !formattedImage.startsWith("https://")) {
    formattedImage = `data:image/png;base64,${formattedImage}`;
  }

  if (variant === "precision-v1") {
    return {
      endpoint: "/v1/ai/image-upscaler-precision",
      body: {
        image: formattedImage,
        sharpen: clamp(params.sharpen, 0, 100, 50),
        smart_grain: clamp(params.smartGrain, 0, 100, 7),
        ultra_detail: clamp(params.ultraDetail, 0, 100, 30),
        filter_nsfw: Boolean(params.filterNsfw),
      },
    };
  }

  if (variant === "precision-v2") {
    const rawScale = String(params.scaleFactor || "2x").replace(/x$/i, "");
    const scaleFactor = clamp(rawScale, 2, 16, 2);
    const validFlavors = ["photo", "sublime", "photo_denoiser"];
    const flavor = validFlavors.includes(params.flavor) ? params.flavor : "photo";

    return {
      endpoint: "/v1/ai/image-upscaler-precision-v2",
      body: {
        image: formattedImage,
        scale_factor: scaleFactor,
        flavor,
        sharpen: clamp(params.sharpen, 0, 100, 7),
        smart_grain: clamp(params.smartGrain, 0, 100, 7),
        ultra_detail: clamp(params.ultraDetail, 0, 100, 30),
        filter_nsfw: Boolean(params.filterNsfw),
      },
    };
  }

  // Upscaler Creative
  const validScaleFactors = ["2x", "4x", "8x", "16x"];
  const scale_factor = validScaleFactors.includes(params.scaleFactor) ? params.scaleFactor : "2x";
  const validPresets = MAGNIFIC_CREATIVE_PRESETS.map((p) => p.id);
  const optimized_for = validPresets.includes(params.optimizedFor) ? params.optimizedFor : "standard";
  const validEngines = MAGNIFIC_ENGINES.map((e) => e.id);
  const engine = validEngines.includes(params.engine) ? params.engine : "automatic";

  const body = {
    image: formattedImage,
    scale_factor,
    optimized_for,
    engine,
    creativity: clamp(params.creativity, -10, 10, 0),
    hdr: clamp(params.hdr, -10, 10, 0),
    resemblance: clamp(params.resemblance, -10, 10, 0),
    fractality: clamp(params.fractality, -10, 10, 0),
    filter_nsfw: Boolean(params.filterNsfw),
  };

  if (params.prompt && typeof params.prompt === "string" && params.prompt.trim()) {
    body.prompt = params.prompt.trim();
  }

  return {
    endpoint: "/v1/ai/image-upscaler",
    body,
  };
}

/**
 * Submit an image upscale task to Magnific
 */
export async function submitMagnificUpscale({
  model = "Magnific Creative",
  image,
  params = {},
  apiKey,
  signal,
  fetchImpl = fetch,
}) {
  const key = getApiKey(apiKey);
  if (!key) throw new Error("MAGNIFIC_API_KEY is not configured.");

  const variant = resolveMagnificVariant(model);
  const { endpoint, body } = buildMagnificPayload(variant, { image, params });

  const url = `${MAGNIFIC_BASE_URL}${endpoint}`;
  const timeout = signal ? null : AbortSignal.timeout(30_000);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "x-magnific-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: signal || timeout,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = Array.isArray(json.invalid_params)
      ? json.invalid_params.map((p) => `${p.field}: ${p.reason}`).join(", ")
      : null;
    const errorMsg =
      (json.message && details ? `${json.message} (${details})` : null) ||
      details ||
      json.message ||
      `Magnific API error (${res.status})`;
    throw new Error(errorMsg);
  }

  const taskData = json.data || {};
  if (!taskData.task_id) {
    throw new Error("Magnific API did not return a valid task_id.");
  }

  return {
    taskId: taskData.task_id,
    status: taskData.status || "CREATED",
    variant,
    endpoint,
  };
}

/**
 * Poll task status from Magnific
 */
export async function getMagnificUpscaleStatus({
  model = "Magnific Creative",
  taskId,
  apiKey,
  signal,
  fetchImpl = fetch,
}) {
  if (!taskId) throw new Error("taskId is required.");
  const key = getApiKey(apiKey);
  if (!key) throw new Error("MAGNIFIC_API_KEY is not configured.");

  const variant = resolveMagnificVariant(model);
  let baseEndpoint = "/v1/ai/image-upscaler";
  if (variant === "precision-v1") baseEndpoint = "/v1/ai/image-upscaler-precision";
  else if (variant === "precision-v2") baseEndpoint = "/v1/ai/image-upscaler-precision-v2";

  const url = `${MAGNIFIC_BASE_URL}${baseEndpoint}/${encodeURIComponent(taskId)}`;
  const timeout = signal ? null : AbortSignal.timeout(15_000);
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      "x-magnific-api-key": key,
    },
    signal: signal || timeout,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || `Failed to fetch Magnific task status (${res.status})`);
  }

  const taskData = json.data || {};
  const rawStatus = (taskData.status || "IN_PROGRESS").toUpperCase();

  if (rawStatus === "COMPLETED") {
    const generatedUrls = Array.isArray(taskData.generated) ? taskData.generated : [];
    if (!generatedUrls.length) {
      throw new Error("Magnific task completed but returned no output image URL.");
    }
    return {
      status: "succeeded",
      generatedUrls,
      generatedUrl: generatedUrls[0],
      taskId,
    };
  }

  if (rawStatus === "FAILED") {
    return {
      status: "failed",
      error: taskData.error || json.message || "Magnific upscale task failed.",
      taskId,
    };
  }

  return {
    status: "running",
    taskId,
  };
}
