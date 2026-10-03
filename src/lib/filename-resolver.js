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
 * Computes a deterministic short namespace suffix for disambiguating colliding slugs.
 * Guarantees distinctness among all colliding namespaces in the authoritative library.
 */
export function getNamespaceDisambiguator(namespace, collidingNamespaces = []) {
  if (!namespace || namespace === "global_unsorted") return null;
  const parts = namespace.split(":");
  if (parts.length < 2) return null;
  const rawId = parts[1].replace(/-/g, "").toLowerCase();

  const otherIds = (collidingNamespaces || [])
    .filter((ns) => ns !== namespace)
    .map((ns) => ns.split(":")[1]?.replace(/-/g, "").toLowerCase())
    .filter(Boolean);

  let len = 4;
  while (len < rawId.length && otherIds.some((other) => other.slice(0, len) === rawId.slice(0, len))) {
    len += 2;
  }
  return rawId.slice(0, len);
}

/**
 * Enforces bounded byte length (max 255 bytes) for the full filename while preserving entropy.
 */
function boundFilename(baseSlug, serialStr, ext) {
  const suffix = `_${serialStr}.${ext}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const maxBaseBytes = 255 - suffixBytes;

  let currentBytes = Buffer.byteLength(baseSlug, "utf8");
  if (currentBytes <= maxBaseBytes) {
    return `${baseSlug}${suffix}`;
  }

  // Calculate 6-character hex hash of the full un-truncated base slug
  const hash = createHash("sha256").update(baseSlug).digest("hex").slice(0, 6);
  const hashSuffix = `_${hash}`;
  const maxTruncatedBytes = maxBaseBytes - Buffer.byteLength(hashSuffix, "utf8");

  // Truncate UTF-8 string safely
  let truncated = baseSlug;
  while (Buffer.byteLength(truncated, "utf8") > maxTruncatedBytes && truncated.length > 0) {
    truncated = truncated.slice(0, -1);
  }
  truncated = truncated.replace(/_+$/, "");

  return `${truncated}${hashSuffix}${suffix}`;
}

/**
 * Pure, deterministic filename resolver.
 * Accepts ancestry path, project name, namespace, sequence, kind, and media metadata.
 * Produces cross-platform safe, bounded, case- and normalization-safe filenames.
 */
export function resolveGenerationFilename({
  project = null,
  ancestry = [],
  namespace = "global_unsorted",
  sequence = 1,
  kind = "image",
  url = "",
  mediaKey = "",
  contentType = "",
  disambiguator = null,
} = {}) {
  const tokens = [];

  if (namespace === "global_unsorted") {
    tokens.push("library", "unsorted");
  } else if (namespace.startsWith("project_unsorted:")) {
    const projSlug = slugifyToken(project?.name || "project", "project");
    tokens.push(projSlug, "unsorted");
    if (disambiguator) {
      tokens.push(disambiguator);
    }
  } else if (namespace.startsWith("folder:")) {
    if (project) {
      tokens.push(slugifyToken(project.name, "project"));
    }
    if (Array.isArray(ancestry) && ancestry.length > 0) {
      for (const folder of ancestry) {
        tokens.push(slugifyToken(folder.name, "folder"));
      }
    } else {
      tokens.push("folder");
    }
    if (disambiguator) {
      tokens.push(disambiguator);
    }
  } else {
    tokens.push("library", "unsorted");
  }

  let baseSlug = tokens.join("_");

  // Prevent Windows reserved device names
  if (WINDOWS_RESERVED_NAMES.has(baseSlug.toUpperCase())) {
    baseSlug = `_${baseSlug}`;
  }

  const serialStr = formatSerial(sequence);
  const ext = resolveExtension({ kind, url, mediaKey, contentType });

  return boundFilename(baseSlug, serialStr, ext);
}

/**
 * Batched database filename resolver for arbitrary generation IDs.
 * Canonical and strictly batch-independent: collision detection evaluates against the
 * authoritative database library, guaranteeing that any generation resolves to the EXACT
 * same filename whether queried individually, in a feed page subset, or in a bulk ZIP.
 */
export async function batchResolveGenerationFilenames(db, generationIds) {
  if (!Array.isArray(generationIds) || generationIds.length === 0) {
    return new Map();
  }

  const uniqueIds = [...new Set(generationIds.filter(Boolean))];
  if (!uniqueIds.length) return new Map();

  // 1. Fetch generations with their naming records and project/folder references
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

  // 2. Query ALL folders and projects to build the authoritative library hierarchy
  const [allFoldersRes, allProjectsRes] = await Promise.all([
    db.select({
      id: folders.id,
      parentId: folders.parentId,
      projectId: folders.projectId,
      name: folders.name,
    }).from(folders),
    db.select({
      id: projects.id,
      name: projects.name,
    }).from(projects),
  ]);

  const foldersById = new Map();
  for (const f of allFoldersRes) foldersById.set(f.id, f);

  const projectsById = new Map();
  for (const p of allProjectsRes) projectsById.set(p.id, p);

  // Helper to get ancestry chain from root to leaf
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

  // Compute base slug for any folder in the authoritative library
  function computeFolderBaseSlug(folder) {
    const proj = folder.projectId ? projectsById.get(folder.projectId) : null;
    const ancestry = getAncestryChain(folder.id);
    const tokens = [];
    if (proj) {
      tokens.push(slugifyToken(proj.name, "project"));
    }
    if (ancestry.length > 0) {
      for (const f of ancestry) {
        tokens.push(slugifyToken(f.name, "folder"));
      }
    } else {
      tokens.push("folder");
    }
    return tokens.join("_");
  }

  // Compute base slug for any project unsorted in the authoritative library
  function computeProjectUnsortedBaseSlug(proj) {
    return `${slugifyToken(proj.name, "project")}_unsorted`;
  }

  // Build authoritative library slug collision map
  const slugToNamespaces = new Map();

  // Global unsorted is always unique to itself
  slugToNamespaces.set("library_unsorted", new Set(["global_unsorted"]));

  // Map all project unsorted namespaces
  for (const [projId, proj] of projectsById.entries()) {
    const slug = computeProjectUnsortedBaseSlug(proj);
    if (!slugToNamespaces.has(slug)) slugToNamespaces.set(slug, new Set());
    slugToNamespaces.get(slug).add(`project_unsorted:${projId}`);
  }

  // Map all folder namespaces
  for (const [folderId, folder] of foldersById.entries()) {
    const slug = computeFolderBaseSlug(folder);
    if (!slugToNamespaces.has(slug)) slugToNamespaces.set(slug, new Set());
    slugToNamespaces.get(slug).add(`folder:${folderId}`);
  }

  // 3. Build resolved filenames map for the requested generations
  const resultMap = new Map();
  for (const gen of genRows) {
    const ns = gen.namingNamespace || namespaceFor({ folderId: gen.folderId, projectId: gen.projectId });
    const proj = gen.projectId ? projectsById.get(gen.projectId) : null;
    const ancestry = gen.folderId ? getAncestryChain(gen.folderId) : [];
    const seq = gen.namingSequence || 1;

    let baseSlug;
    if (ns === "global_unsorted") {
      baseSlug = "library_unsorted";
    } else if (ns.startsWith("project_unsorted:")) {
      baseSlug = computeProjectUnsortedBaseSlug(proj || { name: "project" });
    } else if (ns.startsWith("folder:")) {
      const folder = gen.folderId ? foldersById.get(gen.folderId) : null;
      baseSlug = folder ? computeFolderBaseSlug(folder) : (proj ? `${slugifyToken(proj.name, "project")}_folder` : "folder");
    } else {
      baseSlug = "library_unsorted";
    }

    const collidingNamespaces = slugToNamespaces.get(baseSlug) || new Set();
    const hasCollision = collidingNamespaces.size > 1;
    const disambiguator = hasCollision ? getNamespaceDisambiguator(ns, [...collidingNamespaces]) : null;

    const filename = resolveGenerationFilename({
      project: proj,
      ancestry,
      namespace: ns,
      sequence: seq,
      kind: gen.kind,
      url: gen.url,
      disambiguator,
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
