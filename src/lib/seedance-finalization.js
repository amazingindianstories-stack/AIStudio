export const DRAFT_FINALIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function validateDraftForFinalization(source, now = Date.now()) {
  if (!source) return "Source generation not found.";
  if (source.kind !== "video") return "Only video drafts can be finalized.";
  if (source.model !== "Seedance 2.5") return "Only Seedance 2.5 drafts can be finalized.";
  if (source.draftMode !== true) return "This generation is not a draft.";
  if (source.status !== "succeeded") return "The draft must finish successfully before it can be finalized.";
  if (!source.taskId) return "The draft has no provider task ID and cannot be finalized.";
  if (!Number.isFinite(source.createdAt) || now - source.createdAt > DRAFT_FINALIZATION_TTL_MS) {
    return "This draft is older than seven days and can no longer be finalized.";
  }
  return null;
}

export function canFinalizeDraft(source, now = Date.now()) {
  return validateDraftForFinalization(source, now) === null;
}

export function buildFinalGeneration(source, { id, userId, costCents, now = Date.now() }) {
  return {
    id, kind: "video", status: "queued", prompt: source.prompt, model: source.model,
    aspectRatio: source.aspectRatio, resolution: "1080p", duration: source.duration,
    referenceImages: source.referenceImages, referenceVideos: source.referenceVideos,
    referenceAudios: source.referenceAudios, projectId: source.projectId, folderId: source.folderId,
    userId, costCents, costBasis: "estimated", generateAudio: source.generateAudio,
    draftMode: false, bitrateMode: source.bitrateMode, videoTaskMode: source.videoTaskMode,
    sourceGenerationId: source.id, draftTaskId: source.taskId, createdAt: now, updatedAt: now,
  };
}
