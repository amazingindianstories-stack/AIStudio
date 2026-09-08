import {
  DEFAULTS,
  MODELS,
  aspectRatiosForModel,
  resolutionsForModel,
  durationsForModel,
  durationRangeForModel,
  supportsAudio,
  supportsVideoReference,
  supportsVideoEditExtend,
  supportsFirstFrameContinuation,
} from "./config";

export const COMPOSER_FIELDS = [
  "model",
  "aspectRatio",
  "resolution",
  "duration",
  "batchCount",
  "generateAudio",
  "videoTaskMode",
  "seed",
  "continuationFrame",
  "prompt",
  "referenceImages",
  "referenceKinds",
  "referenceLabels",
  "referenceVideos",
  "referenceAudios",
  "stagedReferenceVideos",
  "stagedContinuationFrame",
  "audioNotes",
  "productionContext",
];
export function composerSnapshot(state) {
  return Object.fromEntries(COMPOSER_FIELDS.map((key) => [key, state[key]]));
}
export function modeTransition(state, mode) {
  if (!DEFAULTS[mode] || state.mode === mode) return {};
  const drafts = { ...state.modeDrafts, [state.mode]: composerSnapshot(state) };
  const next = drafts[mode] ?? {
    ...DEFAULTS[mode],
    duration: DEFAULTS[mode].duration ?? 5,
    batchCount: 1,
    generateAudio: supportsAudio(DEFAULTS[mode].model),
    videoTaskMode: "generate",
    seed: null,
    continuationFrame: null,
    prompt: "",
    referenceImages: [],
    referenceKinds: [],
    referenceLabels: [],
    referenceVideos: [],
    referenceAudios: [],
    stagedReferenceVideos: [],
    stagedContinuationFrame: null,
    audioNotes: [],
    productionContext: null,
  };
  return {
    ...next,
    mode,
    modeDrafts: drafts,
    composerNotice: `Your ${state.mode} draft is preserved. ${drafts[mode] ? "Restored" : "Started"} your ${mode} draft.`,
  };
}
export function modelTransition(state, model) {
  if (
    !MODELS.some((m) => m.kind === state.mode && m.name === model) ||
    model === state.model
  )
    return {};
  const saved = state.modelPreferences?.[model] ?? state;
  const range = durationRangeForModel(model);
  const durations = durationsForModel(model);
  const resolutions = resolutionsForModel(
    model,
    state.mode,
    state.referenceImages.length > 0,
  );
  const aspects = aspectRatiosForModel(model, state.mode);
  const next = {
    model,
    duration: range
      ? Math.min(range.max, Math.max(range.min, saved.duration || range.min))
      : durations.includes(saved.duration)
        ? saved.duration
        : durations[0],
    resolution: (model === "Seedream 5.0 Pro" || model === "seedream-5-pro") && model !== state.model ? "2K" : resolutions.includes(saved.resolution)
      ? saved.resolution
      : resolutions[0],
    aspectRatio: aspects.includes(saved.aspectRatio)
      ? saved.aspectRatio
      : aspects[0],
    generateAudio: supportsAudio(model) && saved.generateAudio === true,
    videoTaskMode: supportsVideoEditExtend(model)
      ? (saved.videoTaskMode ?? "generate")
      : "generate",
    referenceVideos: supportsVideoReference(model)
      ? state.referenceVideos.length
        ? state.referenceVideos
        : (state.stagedReferenceVideos ?? [])
      : [],
    stagedReferenceVideos: supportsVideoReference(model)
      ? []
      : state.referenceVideos.length
        ? state.referenceVideos
        : (state.stagedReferenceVideos ?? []),
    continuationFrame: supportsFirstFrameContinuation(model)
      ? (state.continuationFrame ?? state.stagedContinuationFrame)
      : null,
    stagedContinuationFrame: supportsFirstFrameContinuation(model)
      ? null
      : (state.continuationFrame ?? state.stagedContinuationFrame),
    modelPreferences: {
      ...state.modelPreferences,
      [state.model]: {
        duration: state.duration,
        resolution: state.resolution,
        aspectRatio: state.aspectRatio,
        generateAudio: state.generateAudio,
        videoTaskMode: state.videoTaskMode,
      },
    },
  };
  const changes = [
    "aspectRatio",
    "resolution",
    "duration",
    "generateAudio",
    "videoTaskMode",
  ]
    .filter((key) => next[key] !== state[key])
    .map(
      (key) =>
        `${{ aspectRatio: "Aspect", resolution: "Resolution", duration: "Duration", generateAudio: "Audio", videoTaskMode: "Task" }[key]}: ${state[key]} → ${next[key]}`,
    );
  if (next.stagedReferenceVideos.length)
    changes.push(
      "Attached clips are preserved but will not be sent by this model",
    );
  if (next.stagedContinuationFrame)
    changes.push(
      "Continuation frame is preserved but will not be sent by this model",
    );
  return {
    ...next,
    composerNotice:
      changes.join(". ") ||
      "Model changed. Your prompt and references are preserved.",
  };
}

/** Validate persisted settings against the current catalog without losing text. */
export function restoreComposerSnapshot(mode, draft) {
  if (
    !DEFAULTS[mode] ||
    !draft ||
    !MODELS.some((model) => model.kind === mode && model.name === draft.model)
  )
    return null;
  const restored = composerSnapshot(draft);
  for (const key of [
    "referenceImages",
    "referenceKinds",
    "referenceLabels",
    "referenceVideos",
    "referenceAudios",
    "stagedReferenceVideos",
    "audioNotes",
  ]) {
    if (
      draft[key] !== undefined &&
      (!Array.isArray(draft[key]) ||
        draft[key].some((value) => typeof value !== "string"))
    )
      return null;
    restored[key] = draft[key] || [];
  }
  restored.prompt = typeof draft.prompt === "string" ? draft.prompt : "";
  const aspects = aspectRatiosForModel(draft.model, mode);
  const resolutions = resolutionsForModel(
    draft.model,
    mode,
    restored.referenceImages.length > 0,
  );
  restored.aspectRatio = aspects.includes(draft.aspectRatio)
    ? draft.aspectRatio
    : aspects[0];
  restored.resolution = resolutions.includes(draft.resolution)
    ? draft.resolution
    : resolutions[0];
  const range = durationRangeForModel(draft.model);
  const durations = durationsForModel(draft.model);
  restored.duration = range
    ? Number.isInteger(draft.duration)
      ? Math.max(range.min, Math.min(range.max, draft.duration))
      : range.min
    : durations.includes(draft.duration)
      ? draft.duration
      : durations[0];
  restored.batchCount = [1, 2, 3, 4].includes(draft.batchCount)
    ? draft.batchCount
    : 1;
  restored.generateAudio =
    supportsAudio(draft.model) && draft.generateAudio === true;
  restored.videoTaskMode =
    supportsVideoEditExtend(draft.model) &&
    ["edit", "extend"].includes(draft.videoTaskMode)
      ? draft.videoTaskMode
      : "generate";
  restored.seed = Number.isSafeInteger(draft.seed) ? draft.seed : null;
  restored.continuationFrame =
    typeof draft.continuationFrame === "string"
      ? draft.continuationFrame
      : null;
  restored.stagedContinuationFrame =
    typeof draft.stagedContinuationFrame === "string"
      ? draft.stagedContinuationFrame
      : null;
  restored.productionContext =
    draft.productionContext &&
    typeof draft.productionContext === "object" &&
    !Array.isArray(draft.productionContext)
      ? draft.productionContext
      : null;
  return restored;
}
