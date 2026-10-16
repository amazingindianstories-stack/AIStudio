/** Display remote registration evidence without promising model acceptance. */
export function portraitReadiness(asset = {}) {
  asset = asset || {};
  const status = String(asset.status || "").trim().toLowerCase();
  const registered = typeof asset.byteplusAssetId === "string" && asset.byteplusAssetId.trim().length > 0;
  if (["previewdeleted", "deleted"].includes(status)) return {state:"removed", remoteReady:false, label:"Removed", detail:"This portrait has been removed from the gallery."};
  if (["failed", "error", "rejected"].includes(status)) return {state:"error", remoteReady:false, label:"Failed", detail:"This portrait could not be prepared for video. Upload it again."};
  if (Object.prototype.hasOwnProperty.call(asset, "remoteVerification")) {
    const verification = String(asset.remoteVerification || "").toLowerCase();
    if (verification === "absent") return {state:"missing",remoteReady:false,label:"Unavailable for video",detail:"The video service no longer has this portrait. You can still view and download it."};
    if (verification === "unverified" || !["active","processing","failed","local_only"].includes(verification)) return {state:"unverified",remoteReady:false,label:"Checking",detail:"Still checking whether this portrait is ready. Try again shortly."};
    if (verification === "processing") return {state:"pending",remoteReady:false,label:"Processing",detail:"This portrait is being prepared for video."};
    if (verification === "failed") return {state:"error",remoteReady:false,label:"Failed",detail:"This portrait could not be prepared for video. Upload it again."};
    if (verification === "local_only") return {state:"local",remoteReady:false,label:"Image only",detail:"This portrait can be viewed but isn't ready for video."};
  }
  if (registered && status === "active") return {state:"registered", remoteReady:true, label:"Ready", detail:"Ready to use in video generations."};
  if (["processing", "pending", "queued"].includes(status)) return {state:"pending", remoteReady:false, label:"Processing", detail:"This portrait is being prepared for video."};
  if (registered) return {state:"pending", remoteReady:false, label:"Checking", detail:"Still checking whether this portrait is ready. Try again shortly."};
  return {state:"local", remoteReady:false, label:"Image only", detail:"This portrait can be viewed but isn't ready for video."};
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
    dimensions_out_of_bounds: "Saved, but not ready for video: width and height must be 300–6000 pixels.",
    QuotaSharedPoolExceeded: "Saved, but not ready for video: portrait storage is full.",
    registration_outcome_unknown: "Saved. Video readiness is still being confirmed — don't upload it again yet.",
    group_registration_outcome_unknown: "Character setup is still being confirmed — don't retry yet.",
    registration_validation_failed: "Saved, but video readiness could not be confirmed.",
  };
  if (typeof code === "string" && known[code]) return known[code];
  if (typeof error === "string" && known[error]) return known[error];
  return "Saved, but not ready for video. Check its status in the Gallery before retrying.";
}

/** Hide only a registered group explicitly absent in a complete remote inventory. */
export function portraitGroupVisible(group) {
  return !(group?.remoteGroupMissing === true && !group.groupOperationHold && typeof group.byteplusGroupId === "string" && group.byteplusGroupId.trim().length > 0);
}

const QUOTA_CODES = new Set(["QuotaSharedPoolExceeded"]);
const QUOTA_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function quotaRejectedAt(asset) {
  if (asset?.status !== "RegistrationFailed") return 0;
  try {
    const marker = JSON.parse(asset.statusMessage || "{}");
    return marker && QUOTA_CODES.has(marker.error_code) ? Number(asset.updatedAt || asset.createdAt) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * The BytePlus portrait library is full when the latest registration was rejected for quota
 * and nothing has been registered (or freed by a confirmed remote delete) since.
 */
export function portraitLibraryFull(assets = [], { fullAt = 0, freedAt = 0, now = Date.now() } = {}) {
  let rejected = Number(fullAt) || 0, registered = 0;
  for (const asset of Array.isArray(assets) ? assets : []) {
    rejected = Math.max(rejected, quotaRejectedAt(asset));
    if (asset?.status === "Active" && asset.byteplusAssetId) registered = Math.max(registered, Number(asset.updatedAt || asset.createdAt) || 0);
  }
  const full = rejected > 0 && rejected > registered && rejected > (Number(freedAt) || 0) && now - rejected < QUOTA_WINDOW_MS;
  return { full, since: full ? rejected : null, freedSince: !full && rejected > 0 && (Number(freedAt) || 0) >= rejected };
}
