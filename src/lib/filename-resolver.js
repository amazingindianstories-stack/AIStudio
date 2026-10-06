import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { folders, generationNaming, generations, projects } from "./schema.js";
import { namespaceFor } from "./generation-naming.js";

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Portable ASCII slugification for a path segment or name token.
 * Uses NFKD decomposition, strips non-ASCII diacritics, converts to lowercase,
 * collapses separators to a single underscore, and strips edge underscores.
 * Guarantees output contains ONLY [a-z0-9_] with single underscores,
 * making double hyphen '--' a strictly reserved, un-impersonable delimiter.
 */
export function slugifyToken(rawName, fallback = "folder") {
  if (typeof rawName !== "string" || !rawName.trim()) {
    return fallback;
  }

  const normalized = rawName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const slug = normalized
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug || fallback;
}

/**
 * Resolves the trusted media file extension based on MIME type, key, or generation kind.
 */
export function resolveExtension({ kind = "image", url = "", mediaKey = "", contentType = "" } = {}) {
  if (contentType) {
    const mime = String(contentType).split(";")[0].trim().toLowerCase();
    if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
    if (mime === "image/png") return "png";
    if (mime === "image/webp") return "webp";
    if (mime === "image/gif") return "gif";
    if (mime === "video/mp4") return "mp4";
    if (mime === "video/webm") return "webm";
    if (mime === "video/quicktime") return "mov";
    if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
    if (mime === "audio/wav") return "wav";
  }

  const candidate = mediaKey || url || "";
  const match = String(candidate).split("?")[0].split("#")[0].match(/\.([a-z0-9]{2,5})$/i);
  if (match) {
    const ext = match[1].toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm", "mov", "mp3", "wav"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }

  if (kind === "video") return "mp4";
  if (kind === "image" || kind === "depth") return "png";
  if (kind === "audio") return "mp3";
  return "bin";
}

/**
 * Pads sequence number to at least 4 digits, naturally expanding beyond 9999.
 */
export function formatSerial(sequence) {
  const num = Math.max(1, Math.floor(Number(sequence) || 1));
  return String(num).padStart(4, "0");
}

/**
 * Derives a full, fixed-width (32 lowercase hex characters) unique namespace token.
 * For folders: 32 hex chars of the folder UUID.
 * For project unsorted: 32 hex chars of the project UUID.
 * For global unsorted: 32 hex zeros.
 * Because user slugification produces only single underscores [a-z0-9_],
 * prefixing this token with '--' ensures it can NEVER be impersonated by any folder or project name.
 */
export function canonicalNamespaceToken(namespace) {
  if (!namespace || namespace === "global_unsorted") {
    return "00000000000000000000000000000000";
  }
  const parts = namespace.split(":");
  const rawId = (parts[1] || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return rawId.padEnd(32, "0").slice(0, 32);
}

/**
 * Legacy compatibility helper for tests expecting short disambiguator.
 */
export function getNamespaceDisambiguator(namespace, _collidingNamespaces = []) {
  if (!namespace || namespace === "global_unsorted") return null;
  const token = canonicalNamespaceToken(namespace);
  return token.slice(0, 4);
}

/**
 * Enforces bounded byte length (max 255 UTF-8 bytes) for the full filename.
 * Keep the folder path and stable serial; no project or internal ID decoration.
 * A hash is used only when a path is too long to fit on the filesystem.
 */
export function boundFilename({ readablePrefix, serialStr, ext }) {
  const suffix = `_${serialStr}.${ext}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const maxReadableBytes = 255 - suffixBytes;

  const currentReadableBytes = Buffer.byteLength(readablePrefix, "utf8");
  if (currentReadableBytes <= maxReadableBytes) {
    return `${readablePrefix}${suffix}`;
  }

  // Calculate 16-character hex hash of the full un-truncated readable prefix for entropy
  const hash = createHash("sha256").update(readablePrefix).digest("hex").slice(0, 16);
  const hashSuffix = `_${hash}`;
  const maxTruncatedBytes = maxReadableBytes - Buffer.byteLength(hashSuffix, "utf8");

  // Truncate UTF-8 string safely
  let truncated = readablePrefix;
  while (Buffer.byteLength(truncated, "utf8") > maxTruncatedBytes && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  truncated = truncated.replace(/_+$/, "");

  return `${truncated}${hashSuffix}${suffix}`;
}

/**
 * Pure, deterministic filename resolver.
 * Accepts ancestry path, project name, namespace, sequence, kind, and media metadata.
 * Produces portable folder-path filenames. Names are unique within a naming
 * namespace, rather than decorated with internal IDs across the whole library.
 * ZIP finalization rejects duplicate names across namespaces before enqueueing.
 */
export function resolveGenerationFilename({
  ancestry = [],
  namespace = "global_unsorted",
  sequence = 1,
  kind = "image",
  url = "",
  mediaKey = "",
  contentType = "",
} = {}) {
  const tokens = [];

  if (namespace === "global_unsorted") {
    tokens.push("unsorted");
  } else if (namespace.startsWith("project_unsorted:")) {
    tokens.push("unsorted");
  } else if (namespace.startsWith("folder:")) {
    if (Array.isArray(ancestry) && ancestry.length > 0) {
      for (const folder of ancestry) {
        const token = slugifyToken(folder.name, "folder");
        tokens.push(/^(?:r|sc)\d+$/i.test(token) ? token.toUpperCase() : token);
      }
    } else {
      tokens.push("folder");
    }
  } else {
    tokens.push("unsorted");
  }

  let readablePrefix = tokens.join("_");

  // Prevent Windows reserved device names
  if (WINDOWS_RESERVED_NAMES.has(readablePrefix.toUpperCase())) {
    readablePrefix = `_${readablePrefix}`;
  }

  const serialStr = formatSerial(sequence);
  const ext = resolveExtension({ kind, url, mediaKey, contentType });

  return boundFilename({ readablePrefix, serialStr, ext });
}

/**
 * Batched database filename resolver for arbitrary generation IDs.
 * Canonical, strictly batch-independent, and avoids full-library table scans:
 * Only queries the ancestor chains for the specific folders in the batch using a recursive CTE.
 */
export async function batchResolveGenerationFilenames(db, generationIds) {
  if (!Array.isArray(generationIds) || generationIds.length === 0) {
    return new Map();
  }

  const uniqueIds = [...new Set(generationIds.filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  // 1. Fetch generations with their naming records
  const genRows = await db
    .select({
      id: generations.id,
      kind: generations.kind,
      url: generations.url,
      projectId: generations.projectId,
      folderId: generations.folderId,
      namingNamespace: generationNaming.namespace,
      namingSequence: generationNaming.sequence,
    })
    .from(generations)
    .leftJoin(generationNaming, eq(generations.id, generationNaming.generationId))
    .where(inArray(generations.id, uniqueIds));

  if (!genRows.length) return new Map();

  // 2. Collect unique folderIds and projectIds needed for THIS batch
  const folderIdsToFetch = new Set();
  const projectIdsToFetch = new Set();

  for (const gen of genRows) {
    if (gen.folderId) folderIdsToFetch.add(gen.folderId);
    if (gen.projectId) projectIdsToFetch.add(gen.projectId);
  }

  // 3. Efficiently fetch folder ancestry without full-library scan
  const foldersById = new Map();
  let currentFolderIds = [...folderIdsToFetch];
  while (currentFolderIds.length > 0) {
    const rows = await db
      .select({
        id: folders.id,
        parentId: folders.parentId,
        projectId: folders.projectId,
        name: folders.name,
      })
      .from(folders)
      .where(inArray(folders.id, currentFolderIds));

    currentFolderIds = [];
    for (const r of rows) {
      if (!foldersById.has(r.id)) {
        foldersById.set(r.id, r);
        if (r.projectId) projectIdsToFetch.add(r.projectId);
        if (r.parentId && !foldersById.has(r.parentId)) {
          currentFolderIds.push(r.parentId);
        }
      }
    }
  }

  // 4. Fetch only the referenced projects
  const projectsById = new Map();
  if (projectIdsToFetch.size > 0) {
    const projectRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, [...projectIdsToFetch]));

    for (const p of projectRows) {
      projectsById.set(p.id, p);
    }
  }

  function getAncestryChain(folderId) {
    const ancestry = [];
    let curr = foldersById.get(folderId);
    const visited = new Set();
    while (curr && !visited.has(curr.id)) {
      visited.add(curr.id);
      ancestry.unshift({ id: curr.id, name: curr.name });
      curr = curr.parentId ? foldersById.get(curr.parentId) : null;
    }
    return ancestry;
  }

  // 5. Build resolved filenames map for the requested generations
  const resultMap = new Map();
  for (const gen of genRows) {
    const ns = gen.namingNamespace || namespaceFor({ folderId: gen.folderId, projectId: gen.projectId });
    const folder = gen.folderId ? foldersById.get(gen.folderId) : null;
    const effectiveProjectId = gen.projectId || folder?.projectId || null;
    const proj = effectiveProjectId ? projectsById.get(effectiveProjectId) : null;
    const ancestry = gen.folderId ? getAncestryChain(gen.folderId) : [];
    const seq = gen.namingSequence || 1;

    const filename = resolveGenerationFilename({
      project: proj,
      ancestry,
      namespace: ns,
      sequence: seq,
      kind: gen.kind,
      url: gen.url,
    });

    resultMap.set(gen.id, {
      generationId: gen.id,
      filename,
      namespace: ns,
      sequence: seq,
      extension: resolveExtension({ kind: gen.kind, url: gen.url }),
    });
  }

  return resultMap;
}
