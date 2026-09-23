import { supportsBitrateMode, supportsDraftMode } from "./config";

export const BITRATE_MODES = ["standard", "high"];

export function resolveSeedanceRenderControls(model, body = {}) {
  if (body.bitrateMode !== undefined && !BITRATE_MODES.includes(body.bitrateMode)) {
    return { error: "Bitrate must be either standard or high." };
  }
  if (!supportsDraftMode(model) || !supportsBitrateMode(model)) return {};
  return {
    draftMode: body.draftMode === true,
    bitrateMode: body.bitrateMode ?? "high",
  };
}
