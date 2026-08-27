export const MEDIA_ACTION_COPY = {
  retryTextToVideo: {
    title: "Retry without references?",
    description:
      "This starts a new billable video generation. All reference images, clips, and @reference tags will be removed from the retry.",
    confirmLabel: "Start retry",
  },
  regenerate: {
    title: "Generate this again?",
    description:
      "This immediately starts another billable generation using the saved prompt, settings, and references.",
    confirmLabel: "Generate again",
  },
  regenerateWithSameSeed: {
    title: "Regenerate with the same seed?",
    description:
      "This immediately starts another billable generation using the original seed, prompt, settings, and references.",
    confirmLabel: "Regenerate",
  },
  cloneToComposer: {
    title: "Replace the current composer?",
    description:
      "This loads the saved prompt, settings, and references into the composer and replaces any unsaved draft. It does not start a generation.",
    confirmLabel: "Replace composer",
  },
  editPrompt: {
    title: "Replace the current prompt?",
    description:
      "This loads the saved prompt into the composer and replaces the current unsaved prompt. It does not start a generation.",
    confirmLabel: "Load prompt",
  },
  continueShot: {
    title: "Prepare a continuation?",
    description:
      "This replaces the current composer with this clip's final frame and clears the prompt so you can write the next shot. It does not start a generation.",
    confirmLabel: "Replace composer",
  },
  deleteGeneration: {
    title: "Delete this generation?",
    description: "This permanently removes the generation from your history. This cannot be undone.",
    confirmLabel: "Delete",
    destructive: true,
  },
  deleteAsset: {
    title: "Delete this saved asset?",
    description:
      "This permanently removes the saved asset and its stored reference images. This cannot be undone.",
    confirmLabel: "Delete asset",
    destructive: true,
  },
};

export function mediaActionCopy(kind) {
  const copy = MEDIA_ACTION_COPY[kind];
  if (!copy) throw new Error(`Unknown confirmed media action: ${kind}`);
  return copy;
}
