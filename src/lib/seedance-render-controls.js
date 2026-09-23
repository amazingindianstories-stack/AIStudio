import { supportsBitrateMode, supportsDraftMode } from "./config";

export const BITRATE_MODES = ["standard", "high"];

export function resolveSeedanceRenderControls(model, body = {}) {
  if (body.bitrateMode !== undefined && !BITRATE_MODES.includes(body.bitrateMode)) {
    return { error: "Bitrate must be either standard or high." };
  }
  const controls = {};
  if (supportsDraftMode(model)) controls.draftMode = body.draftMode === true;
  if (supportsBitrateMode(model)) controls.bitrateMode = body.bitrateMode ?? "high";
  return controls;
}
