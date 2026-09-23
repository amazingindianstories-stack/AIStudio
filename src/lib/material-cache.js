export const MATERIAL_CACHE_MAX = 12;
export const MATERIAL_FRESH_MS = 30_000;

const cache = new Map();
const requests = new Map();

export function materialKey(projectId) {
  return projectId || "__all__";
}

export function getMaterialCache(key) {
  return cache.get(key);
}

export function isMaterialFresh(entry, now = Date.now()) {
  return Boolean(entry && now - entry.at < MATERIAL_FRESH_MS);
}

export function putMaterialCache(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MATERIAL_CACHE_MAX) cache.delete(cache.keys().next().value);
}

export function dedupeMaterialRequest(key, fetcher) {
  if (requests.has(key)) return requests.get(key);
  const request = Promise.resolve().then(fetcher);
  requests.set(key, request);
  request.finally(() => {
    if (requests.get(key) === request) requests.delete(key);
  }).catch(() => {});
  return request;
}

export function patchMaterialCaches(asset) {
  for (const [key, entry] of Array.from(cache.entries())) {
    const belongs = key === "__all__" || key === materialKey(asset.projectId);
    const items = entry.items.filter((item) => item.id !== asset.id);
    cache.set(key, { ...entry, items: belongs ? [asset, ...items] : items });
  }
}

export function dropMaterialCaches(id) {
  for (const [key, entry] of Array.from(cache.entries())) {
    cache.set(key, { ...entry, items: entry.items.filter((item) => item.id !== id) });
  }
}

export function clearMaterialCache() {
  cache.clear();
  requests.clear();
}
