import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { generationNaming, generations, projects } from "./schema.js";
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
 */
export function getNamespaceDisambiguator(namespace) {
  if (!namespace || namespace === "global_unsorted") return null;
  const parts = namespace.split(":");
  if (parts.length < 2) return null;
  return parts[1].replace(/-/g, "").slice(0, 4);
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
 * Queries ancestry in a single recursive CTE and resolves filenames deterministically.
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

  // 2. Collect referenced projects and folders
  const projectIds = [...new Set(genRows.map((r) => r.projectId).filter(Boolean))];
  const folderIds = [...new Set(genRows.map((r) => r.folderId).filter(Boolean))];

  // 3. Query projects
  const projectMap = new Map();
  if (projectIds.length > 0) {
    const projRows = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    for (const p of projRows) projectMap.set(p.id, p);
  }

  // 4. Query full ancestry for all referenced folders via single recursive CTE
  const ancestryByFolderId = new Map();
  if (folderIds.length > 0) {
    const ancestryRes = await db.execute(sql`
      WITH RECURSIVE folder_ancestry AS (
        SELECT id, parent_id, name, id AS leaf_id, 0 AS depth
        FROM folders
        WHERE id IN (${sql.join(folderIds.map((id) => sql`${id}`), sql`, `)})

        UNION ALL

        SELECT f.id, f.parent_id, f.name, fa.leaf_id, fa.depth + 1
        FROM folders f
        JOIN folder_ancestry fa ON f.id = fa.parent_id
      )
      SELECT leaf_id, id, name, depth
      FROM folder_ancestry
      ORDER BY leaf_id, depth DESC;
    `);

    const rows = ancestryRes.rows ?? ancestryRes;
    for (const row of rows) {
      const leafId = row.leaf_id;
      if (!ancestryByFolderId.has(leafId)) {
        ancestryByFolderId.set(leafId, []);
      }
      ancestryByFolderId.get(leafId).push({ id: row.id, name: row.name });
    }
  }

  // 5. Detect potential namespace slug collisions across the batch to ensure uniqueness
  const namespaceSlugs = new Map();
  for (const gen of genRows) {
    const ns = gen.namingNamespace || namespaceFor({ folderId: gen.folderId, projectId: gen.projectId });
    if (!namespaceSlugs.has(ns)) {
      const proj = gen.projectId ? projectMap.get(gen.projectId) : null;
      const ancestry = gen.folderId ? ancestryByFolderId.get(gen.folderId) || [] : [];
      // Compute un-disambiguated slug
      const rawTokens = [];
      if (ns === "global_unsorted") {
        rawTokens.push("library", "unsorted");
      } else if (ns.startsWith("project_unsorted:")) {
        rawTokens.push(slugifyToken(proj?.name || "project", "project"), "unsorted");
      } else if (ns.startsWith("folder:")) {
        if (proj) rawTokens.push(slugifyToken(proj.name, "project"));
        if (ancestry.length > 0) {
          for (const f of ancestry) rawTokens.push(slugifyToken(f.name, "folder"));
        } else {
          rawTokens.push("folder");
        }
      }
      const slugKey = rawTokens.join("_");
      namespaceSlugs.set(ns, slugKey);
    }
  }

  const slugCounts = new Map();
  for (const [, slug] of namespaceSlugs.entries()) {
    slugCounts.set(slug, (slugCounts.get(slug) || 0) + 1);
  }

  // 6. Build resolved filenames map
  const resultMap = new Map();
  for (const gen of genRows) {
    const ns = gen.namingNamespace || namespaceFor({ folderId: gen.folderId, projectId: gen.projectId });
    const proj = gen.projectId ? projectMap.get(gen.projectId) : null;
    const ancestry = gen.folderId ? ancestryByFolderId.get(gen.folderId) || [] : [];
    const seq = gen.namingSequence || 1;

    const baseSlug = namespaceSlugs.get(ns);
    const hasCollision = (slugCounts.get(baseSlug) || 0) > 1;
    const disambiguator = hasCollision ? getNamespaceDisambiguator(ns) : null;

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
