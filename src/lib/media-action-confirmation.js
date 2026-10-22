export const MEDIA_ACTION_COPY = {
  retryTextToVideo: {
    title: "Retry without references?",
    description:
      "Starts a new paid generation with all references and @tags removed.",
    confirmLabel: "Start retry",
    maintenanceWrite: true,
  },
  regenerate: {
    title: "Generate this again?",
    description:
      "Starts a new paid generation with the same prompt, settings and references.",
    confirmLabel: "Generate again",
    maintenanceWrite: true,
  },
  regenerateWithSameSeed: {
    title: "Regenerate with the same seed?",
    description:
      "Starts a new paid generation with the same seed, prompt, settings and references.",
    confirmLabel: "Regenerate",
    maintenanceWrite: true,
  },
  cloneToComposer: {
    title: "Replace the current composer?",
    description:
      "Loads this prompt, settings and references, replacing your current draft. Nothing is generated yet.",
    confirmLabel: "Replace composer",
  },
  editRetry: {
    title: "Edit and retry?",
    description:
      "Loads this prompt, settings and references for editing, replacing your current draft. Nothing is generated until you press Generate.",
    confirmLabel: "Load into composer",
  },
  downloadOriginal: {
    title: "Download the original?",
    description: "Downloads the original file in its native format.",
    confirmLabel: "Download",
  },
  addFavorite: {
    title: "Add to favourites?",
    description: "Adds this generation to Favourites.",
    confirmLabel: "Add to favourites",
    maintenanceWrite: true,
  },
  removeFavorite: {
    title: "Remove from favourites?",
    description: "Removes it from Favourites. The generation is kept.",
    confirmLabel: "Remove",
    maintenanceWrite: true,
  },
  editPrompt: {
    title: "Replace the current prompt?",
    description:
      "Replaces your current prompt with this one. Nothing is generated yet.",
    confirmLabel: "Load prompt",
  },
  continueShot: {
    title: "Prepare a continuation?",
    description:
      "Uses this clip's last frame as the start of a new shot and clears the prompt. Nothing is generated yet.",
    confirmLabel: "Replace composer",
  },
  finalizeDraft: {
    title: "Generate the 1080p final?",
    description:
      "Starts a new paid 1080p generation from this draft. The draft stays in your library.",
    confirmLabel: "Generate final",
    maintenanceWrite: true,
  },
  deleteGeneration: {
    title: "Delete this generation?",
    description: "Removes it from your history. This can't be undone.",
    confirmLabel: "Delete",
    destructive: true,
    maintenanceWrite: true,
  },
  deleteAsset: {
    title: "Delete this saved asset?",
    description:
      "Removes the asset and its reference images. This can't be undone.",
    confirmLabel: "Delete asset",
    destructive: true,
    maintenanceWrite: true,
  },
  deletePortrait: {
    title: "Delete this portrait?",
    description:
      "Removes the portrait from the gallery. This can't be undone.",
    confirmLabel: "Delete portrait",
    destructive: true,
    maintenanceWrite: true,
  },
  deletePortraitGroup: {
    title: "Delete this character group?",
    description:
      "Removes the character and all of its portraits. This can't be undone.",
    confirmLabel: "Delete character",
    destructive: true,
    maintenanceWrite: true,
  },
};

export function mediaActionCopy(kind) {
  const copy = MEDIA_ACTION_COPY[kind];
  if (!copy) throw new Error(`Unknown confirmed media action: ${kind}`);
  return copy;
}
