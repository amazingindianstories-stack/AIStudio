/** Fully discover a remote collection before any local reconciliation. */
export async function listAllByteplusPages(listPage, input = {}, { maxPages = 1000, signal } = {}) {
  const items = new Map();
  const tokens = new Set();
  let nextToken;
  for (let page = 0; page < maxPages; page++) {
    signal?.throwIfAborted();
    const response = await listPage({ ...input, maxResults: 100, nextToken }, { signal });
    if (!Array.isArray(response?.Items)) throw new Error("Invalid BytePlus inventory page.");
    for (const item of response.Items) {
      if (!item?.Id) throw new Error("BytePlus inventory item has no ID.");
      items.set(item.Id, item);
    }
    nextToken = response.NextToken;
    if (!nextToken) return { items: [...items.values()].sort((a, b) => a.Id.localeCompare(b.Id)), pages: page + 1 };
    if (tokens.has(nextToken)) throw new Error("Repeated BytePlus pagination token.");
    tokens.add(nextToken);
  }
  throw new Error("BytePlus inventory exceeded page limit.");
}

export function unlinkedGlobalCandidate(groups, remote, remoteGroups) {
  const normalize = (name) => (name || "").trim().toLowerCase();
  const name = normalize(remote.Name);
  if (!name || remoteGroups.filter((g) => normalize(g.Name) === name).length !== 1) return null;
  const candidates = groups.filter((g) => !g.projectId && !g.byteplusGroupId && normalize(g.name) === name);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Recognize only owned URL classes; an arbitrary provider URL is not durable. */
export function isDurablePortraitRef(ref, env = process.env) {
  if (typeof ref !== "string") return false;
  if (ref.startsWith("/api/media/")) return true;
  const cdn = env.GCP_MEDIA_CDN_URL?.replace(/\/$/, "");
  if (cdn && ref.startsWith(`${cdn}/`)) return true;
  try {
    const url = new URL(ref);
    if ((env.GCP_MEDIA_BUCKET || env.GCS_BUCKET_NAME) && (url.hostname === `${(env.GCP_MEDIA_BUCKET || env.GCS_BUCKET_NAME)}.storage.googleapis.com` ||
      (url.hostname === "storage.googleapis.com" && url.pathname.startsWith(`/${(env.GCP_MEDIA_BUCKET || env.GCS_BUCKET_NAME)}/`)))) return true;
    if (env.AWS_S3_BUCKET_NAME && (new RegExp(`^${env.AWS_S3_BUCKET_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.s3(?:[.-][a-z0-9-]+)?\\.amazonaws\\.com$`).test(url.hostname) ||
      (url.hostname.startsWith("s3.") && url.pathname.startsWith(`/${env.AWS_S3_BUCKET_NAME}/`)))) return true;
  } catch { /* Unknown references remain remote-only. */ }
  return false;
}

export function portraitDisplayRef(localRef, remoteRef) {
  return isDurablePortraitRef(localRef) ? localRef : remoteRef || localRef;
}
