/** Display remote registration evidence without promising model acceptance. */
export function portraitReadiness(asset = {}) {
  asset = asset || {};
  const status = String(asset.status || "").trim().toLowerCase();
  const registered = typeof asset.byteplusAssetId === "string" && asset.byteplusAssetId.trim().length > 0;
  if (["previewdeleted", "deleted"].includes(status)) return {state:"removed", remoteReady:false, label:"Removed", detail:"This portrait has been removed from the gallery."};
  if (["failed", "error", "rejected"].includes(status)) return {state:"error", remoteReady:false, label:"Registration failed", detail:"BytePlus registration has not completed successfully."};
  if (Object.prototype.hasOwnProperty.call(asset, "remoteVerification")) {
    const verification = String(asset.remoteVerification || "").toLowerCase();
    if (verification === "absent") return {state:"missing",remoteReady:false,label:"Not in BytePlus catalog",detail:"The registered ID was absent from the verified remote catalog. View and download remain available."};
    if (verification === "unverified" || !["active","processing","failed","local_only"].includes(verification)) return {state:"unverified",remoteReady:false,label:"Remote registration unverified",detail:"Remote availability has not been verified. Wait before attaching this portrait."};
    if (verification === "processing") return {state:"pending",remoteReady:false,label:"Registration pending",detail:"BytePlus is processing this portrait."};
    if (verification === "failed") return {state:"error",remoteReady:false,label:"Registration failed",detail:"BytePlus reports that registration failed."};
    if (verification === "local_only") return {state:"local",remoteReady:false,label:"Local image only",detail:"No remote portrait registration exists."};
  }
  if (registered && status === "active") return {state:"registered", remoteReady:true, label:"Registered with BytePlus", detail:"Remote registration is active. Generation remains subject to the model's validation."};
  if (["processing", "pending", "queued"].includes(status)) return {state:"pending", remoteReady:false, label:"Registration pending", detail:"Wait for confirmed active remote registration before using this as a registered portrait."};
  if (registered) return {state:"pending", remoteReady:false, label:"Registration unconfirmed", detail:"A remote ID exists, but active registration has not been confirmed."};
  return {state:"local", remoteReady:false, label:"Local image only", detail:"This image is in the gallery but has no registered BytePlus portrait ID."};
}

// The fragment carries catalog identity without changing signed query bytes.
export function portraitReferenceUrl(asset) {
  const ready = portraitReadiness(asset).remoteReady;
  const url = asset?.imageUrl || (ready ? `asset://${asset.byteplusAssetId}` : "");
  if (!url || !ready || url.startsWith("asset://")) return url;
  const base = url.split("#")[0];
  return `${base}#bp_asset_id=${encodeURIComponent(asset.byteplusAssetId.trim())}`;
}

export function portraitAttachAllowed(asset) {
  return portraitReadiness(asset).remoteReady;
}

/** Never expose raw registration provenance, credentials or provider JSON. */
export function portraitRegistrationWarning(error, code) {
  if (!error && !code) return null;
  const known = {
    dimensions_out_of_bounds: "Original saved. BytePlus registration requires image width and height between 300 and 6000 pixels.",
    QuotaSharedPoolExceeded: "BytePlus asset capacity is full. The original was saved locally.",
    registration_outcome_unknown: "Registration outcome is uncertain. Do not retry until it is reconciled.",
    group_registration_outcome_unknown: "Character registration outcome is uncertain. Do not retry until it is reconciled.",
    registration_validation_failed: "BytePlus registration could not be verified.",
  };
  if (typeof code === "string" && known[code]) return known[code];
  if (typeof error === "string" && known[error]) return known[error];
  return "BytePlus registration did not complete. The original remains saved locally; check its Gallery status before retrying.";
}

/** Hide only a registered group explicitly absent in a complete remote inventory. */
export function portraitGroupVisible(group) {
  return !(group?.remoteGroupMissing === true && !group.groupOperationHold && typeof group.byteplusGroupId === "string" && group.byteplusGroupId.trim().length > 0);
}
