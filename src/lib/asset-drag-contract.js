/**
 * Canonical Veevee Asset Drag & Drop Contract
 *
 * Provides a unified, type-safe contract for dragging single or multiple
 * assets between:
 *  - Asset Library & History Panel
 *  - Project Panel & Folders (hierarchical, project, global, unsorted)
 *  - Prompt Composer (reference images & videos)
 *  - Studio Chat
 *  - Upscaler Composer
 *  - Depth Composer
 *  - Canvas Surface
 */

export const VEEVEE_ASSET_MIME = "application/x-veevee-assets";
export const VEEVEE_FOLDER_MIME = "application/x-veevee-folder";

export const LEGACY_ITEM_ID_MIME = "text/itemId";
export const LEGACY_ITEM_ID_LOWER = "text/itemid";
export const LEGACY_ASSET_ID_MIME = "text/assetId";
export const LEGACY_FOLDER_ID_MIME = "text/folderId";

/**
 * Checks whether a native drag event contains Veevee assets.
 * Handles case-sensitivity differences in browser DataTransfer.types.
 *
 * @param {DragEvent} e
 * @returns {boolean}
 */
export function isAssetDragEvent(e) {
  if (!e?.dataTransfer?.types) return false;
  const types = Array.from(e.dataTransfer.types).map((t) => t.toLowerCase());
  return (
    types.includes(VEEVEE_ASSET_MIME.toLowerCase()) ||
    types.includes(LEGACY_ITEM_ID_LOWER) ||
    types.includes(LEGACY_ASSET_ID_MIME.toLowerCase())
  );
}

/**
 * Checks whether a native drag event contains a folder drag.
 *
 * @param {DragEvent} e
 * @returns {boolean}
 */
export function isFolderDragEvent(e) {
  if (!e?.dataTransfer?.types) return false;
  const types = Array.from(e.dataTransfer.types).map((t) => t.toLowerCase());
  return (
    types.includes(VEEVEE_FOLDER_MIME.toLowerCase()) ||
    types.includes(LEGACY_FOLDER_ID_MIME.toLowerCase())
  );
}

/**
 * Checks whether a native drag event represents external files (e.g. from Finder/Explorer).
 *
 * @param {DragEvent} e
 * @returns {boolean}
 */
export function isExternalFileDrag(e) {
  if (!e?.dataTransfer?.types) return false;
  const types = Array.from(e.dataTransfer.types);
  return types.includes("Files") && !isAssetDragEvent(e) && !isFolderDragEvent(e);
}

/**
 * Serializes dragged assets into DataTransfer and attaches visual ghost badge.
 *
 * @param {DataTransfer} dataTransfer
 * @param {Array<Object>} items - Array of full generation/asset items
 * @param {Object} primaryItem - Item under cursor initiating the drag
 */
export function setAssetDragData(dataTransfer, items = [], primaryItem = null) {
  if (!dataTransfer) return;
  const list = Array.isArray(items) && items.length > 0 ? items : primaryItem ? [primaryItem] : [];
  if (list.length === 0) return;

  const targetPrimary = primaryItem || list[0];
  const ids = list.map((item) => item.id).filter(Boolean);

  const payload = {
    ids,
    items: list.map((item) => ({
      id: item.id,
      url: item.url,
      poster: item.poster,
      kind: item.kind,
      status: item.status,
      prompt: item.prompt,
      aspectRatio: item.aspectRatio,
      projectId: item.projectId,
      folderId: item.folderId,
      locationVersion: item.locationVersion,
    })),
    primaryId: targetPrimary?.id || ids[0],
    count: ids.length,
  };

  try {
    dataTransfer.setData(VEEVEE_ASSET_MIME, JSON.stringify(payload));
  } catch {
    /* ignore in environments that disallow custom MIME types */
  }

  // Backwards compatibility keys
  if (targetPrimary?.id) {
    try {
      dataTransfer.setData(LEGACY_ITEM_ID_MIME, targetPrimary.id);
      dataTransfer.setData(LEGACY_ITEM_ID_LOWER, targetPrimary.id);
      dataTransfer.setData(LEGACY_ASSET_ID_MIME, targetPrimary.id);
    } catch {
      /* ignore */
    }
  }

  // URLs for plain text drop targets
  const urls = list
    .map((item) => item.url)
    .filter(Boolean)
    .join("\n");
  if (urls) {
    try {
      dataTransfer.setData("text/plain", urls);
    } catch {
      /* ignore */
    }
  }

  dataTransfer.effectAllowed = "copyMove";

  // Create custom visual drag ghost badge if in browser
  createAssetDragBadge(dataTransfer, targetPrimary, list.length);
}

let currentDraggedFolder = null;

/**
 * Serializes folder drag into DataTransfer.
 *
 * @param {DataTransfer} dataTransfer
 * @param {string} folderId
 * @param {string} folderName
 */
export function setFolderDragData(dataTransfer, folderId, folderName = "Folder") {
  if (!dataTransfer || !folderId) return;

  currentDraggedFolder = { id: folderId, name: folderName };

  const payload = { folderId, name: folderName };
  try {
    dataTransfer.setData(VEEVEE_FOLDER_MIME, JSON.stringify(payload));
  } catch {
    /* ignore */
  }

  try {
    dataTransfer.setData(LEGACY_FOLDER_ID_MIME, folderId);
    dataTransfer.setData("text/folderid", folderId);
    dataTransfer.setData("text/plain", folderName);
  } catch {
    /* ignore */
  }

  dataTransfer.effectAllowed = "move";
}

/**
 * Resets active in-memory dragged folder.
 */
export function clearFolderDragData() {
  currentDraggedFolder = null;
}

/**
 * Returns currently dragged folder if drag originated inside this window.
 *
 * @returns {{ id: string, name: string } | null}
 */
export function getCurrentDraggedFolder() {
  return currentDraggedFolder;
}

/**
 * Determines whether a target folder is equal to or a descendant of an ancestor folder.
 * Prevents cyclical folder hierarchies when dragging folders onto folders.
 *
 * @param {Array<Object>} allFolders - Tree of folder nodes
 * @param {string} ancestorId - Folder being moved
 * @param {string} targetId - Drop target folder
 * @returns {boolean}
 */
export function isFolderDescendant(allFolders, ancestorId, targetId) {
  if (!ancestorId || !targetId) return false;
  if (ancestorId === targetId) return true;

  function findAndCheck(nodes) {
    if (!Array.isArray(nodes)) return false;
    for (const node of nodes) {
      if (node.id === ancestorId) {
        return containsChild(node, targetId);
      }
      if (node.children?.length) {
        const found = findAndCheck(node.children);
        if (found) return true;
      }
    }
    return false;
  }

  function containsChild(node, id) {
    if (!node?.children || !Array.isArray(node.children)) return false;
    for (const child of node.children) {
      if (child.id === id) return true;
      if (containsChild(child, id)) return true;
    }
    return false;
  }

  return findAndCheck(allFolders || []);
}

/**
 * Extracts dragged assets from DataTransfer, falling back to storeState where
 * DataTransfer data is restricted during dragover.
 *
 * @param {DragEvent|DataTransfer} e
 * @param {Object} [storeState] - Optional zustand store state
 * @returns {{ ids: string[], items: Object[], primaryItem: Object|null, count: number }}
 */
export function getAssetDragData(e, storeState = null) {
  const dataTransfer = e?.dataTransfer || e;

  // 1. Try parsing full canonical payload from DataTransfer
  if (dataTransfer?.getData) {
    try {
      const raw = dataTransfer.getData(VEEVEE_ASSET_MIME);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.ids) && parsed.ids.length > 0) {
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const primaryItem =
            items.find((i) => i.id === parsed.primaryId) || items[0] || null;
          return {
            ids: parsed.ids,
            items,
            primaryItem,
            count: parsed.ids.length,
          };
        }
      }
    } catch {
      /* ignore JSON parse errors */
    }

    // 2. Try legacy single itemId / assetId
    const legacyId =
      dataTransfer.getData(LEGACY_ITEM_ID_MIME) ||
      dataTransfer.getData(LEGACY_ITEM_ID_LOWER) ||
      dataTransfer.getData(LEGACY_ASSET_ID_MIME);

    if (legacyId) {
      // If storeState is provided, look up the item
      const itemFromStore = storeState?.items?.find((i) => i.id === legacyId) || null;
      return {
        ids: [legacyId],
        items: itemFromStore ? [itemFromStore] : [{ id: legacyId }],
        primaryItem: itemFromStore || { id: legacyId },
        count: 1,
      };
    }
  }

  // 3. Fallback to storeState's active draggedAssets if available
  if (storeState?.draggedAssets && Array.isArray(storeState.draggedAssets) && storeState.draggedAssets.length > 0) {
    const list = storeState.draggedAssets;
    return {
      ids: list.map((i) => i.id).filter(Boolean),
      items: list,
      primaryItem: storeState.draggedItem || list[0] || null,
      count: list.length,
    };
  }

  if (storeState?.draggedItem) {
    return {
      ids: [storeState.draggedItem.id].filter(Boolean),
      items: [storeState.draggedItem],
      primaryItem: storeState.draggedItem,
      count: 1,
    };
  }

  return { ids: [], items: [], primaryItem: null, count: 0 };
}

/**
 * Extracts folder ID from DataTransfer.
 *
 * @param {DragEvent|DataTransfer} e
 * @returns {string|null}
 */
export function getFolderDragData(e) {
  const dataTransfer = e?.dataTransfer || e;
  if (dataTransfer?.getData) {
    try {
      const raw = dataTransfer.getData(VEEVEE_FOLDER_MIME);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.folderId) return parsed.folderId;
      }
    } catch {
      /* ignore */
    }

    const legacyId =
      dataTransfer.getData(LEGACY_FOLDER_ID_MIME) ||
      dataTransfer.getData("text/folderid");
    if (legacyId) return legacyId;
  }

  if (currentDraggedFolder?.id) {
    return currentDraggedFolder.id;
  }

  return null;
}

/**
 * Validates drop compatibility for Upscaler.
 * Accepts files and generations matching the upscaler's media (image or video).
 *
 * @param {DragEvent} e
 * @param {Object} [storeState]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateUpscalerDrop(e, storeState = null) {
  const isFiles = isExternalFileDrag(e) || Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const isAsset =
    isAssetDragEvent(e) ||
    Boolean(storeState?.draggedItem) ||
    Boolean(storeState?.draggedAssets?.length);

  if (isAsset) {
    const payload = getAssetDragData(e, storeState);
    const items =
      payload.items.length > 0
        ? payload.items
        : payload.ids
            .map((id) => storeState?.items?.find((i) => i.id === id))
            .filter(Boolean);

    if (items.length > 0) {
      const media = storeState?.upscalerMedia === "video" ? "video" : "image";
      // The drop uses the first item, so judge the first item.
      if (items[0].kind !== media) {
        return {
          valid: false,
          reason: media === "video"
            ? "Video upscaling only accepts videos. Switch to Image to upscale an image."
            : "Upscaler only accepts images here. Switch to Video to upscale a video.",
        };
      }
      return {
        valid: true,
        reason: items.length > 1 ? `Drop to use first ${media}` : `Drop to upscale ${media}`,
      };
    }
  }

  if (isFiles) {
    return { valid: true, reason: storeState?.upscalerMedia === "video" ? "Drop video file to upscale" : "Drop image file to upscale" };
  }

  return { valid: false, reason: "Unsupported drag type" };
}

/**
 * Validates drop compatibility for Depth composer.
 * Accepts direct OS video files. Rejects Asset Library generations.
 *
 * @param {DragEvent} e
 * @param {Object} [storeState]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateDepthDrop(e, storeState = null) {
  const isAsset =
    isAssetDragEvent(e) ||
    Boolean(storeState?.draggedItem) ||
    Boolean(storeState?.draggedAssets?.length);

  if (isAsset) {
    return {
      valid: false,
      reason: "Direct video file uploads only — Asset Library generations cannot be used here",
    };
  }

  const isFiles = isExternalFileDrag(e) || Array.from(e.dataTransfer?.types ?? []).includes("Files");
  if (isFiles) {
    return { valid: true, reason: "Drop video file to generate depth map" };
  }

  return { valid: false, reason: "Unsupported drag type" };
}

/**
 * The library items carried by an in-app drag, or null when the drop is not one
 * (for example files from the desktop).
 */
export function droppedLibraryItems(e, storeState = null) {
  const isAsset =
    isAssetDragEvent(e) ||
    Boolean(storeState?.draggedItem) ||
    Boolean(storeState?.draggedAssets?.length);
  if (!isAsset) return null;
  const payload = getAssetDragData(e, storeState);
  return payload.items.length > 0
    ? payload.items
    : payload.ids.map((id) => storeState?.items?.find((i) => i.id === id)).filter(Boolean);
}

/**
 * Validates drop compatibility for Portrait Gallery.
 * Accepts image files and image generations. Rejects videos.
 *
 * @param {DragEvent} e
 * @param {Object} [storeState]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validatePortraitDrop(e, storeState = null) {
  const items = droppedLibraryItems(e, storeState);

  if (items) {
    if (items.length > 0) {
      const hasImage = items.some((item) => item.kind === "image");
      if (!hasImage) {
        return {
          valid: false,
          reason: "Portrait Gallery only accepts images — videos cannot be added",
        };
      }
      return { valid: true, reason: "Drop images into Portrait Gallery" };
    }
  }

  const isFiles = isExternalFileDrag(e) || Array.from(e.dataTransfer?.types ?? []).includes("Files");
  if (isFiles) {
    return { valid: true, reason: "Drop image files" };
  }

  return { valid: false, reason: "Unsupported drag type" };
}

/**
 * Counter-based flicker guard for dropzones with nested DOM elements.
 * Eliminates premature dragleave events when pointer moves over child elements.
 *
 * @param {function(boolean, DragEvent): void} onStateChange
 * @returns {{ enter: function, leave: function, drop: function, reset: function, readonly count: number }}
 */
export function createDropzoneFlickerGuard(onStateChange) {
  let counter = 0;
  return {
    enter: (e) => {
      counter += 1;
      if (counter === 1) {
        onStateChange?.(true, e);
      }
    },
    leave: (e) => {
      counter = Math.max(0, counter - 1);
      if (counter === 0) {
        onStateChange?.(false, e);
      }
    },
    drop: (e) => {
      counter = 0;
      onStateChange?.(false, e);
    },
    reset: () => {
      counter = 0;
      onStateChange?.(false);
    },
    get count() {
      return counter;
    },
  };
}

/**
 * Builds the visual drag badge DOM node safely without innerHTML.
 * Exported for testing and browser environments.
 *
 * @param {Object|null} primaryItem
 * @param {number} count
 * @returns {HTMLElement|null}
 */
export function buildAssetDragBadgeElement(primaryItem, count) {
  if (typeof document === "undefined") return null;

  const badge = document.createElement("div");
  badge.style.position = "fixed";
  badge.style.top = "-9999px";
  badge.style.left = "-9999px";
  badge.style.zIndex = "9999";
  badge.style.pointerEvents = "none";
  badge.style.display = "flex";
  badge.style.alignItems = "center";
  badge.style.gap = "8px";
  badge.style.padding = "6px 12px";
  badge.style.background = "#13161c";
  badge.style.color = "#ffffff";
  badge.style.border = "1px solid rgba(255, 255, 255, 0.2)";
  badge.style.borderRadius = "9999px";
  badge.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.4)";
  badge.style.fontSize = "12px";
  badge.style.fontWeight = "600";
  badge.style.fontFamily = "system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

  if (count > 1) {
    const dot = document.createElement("span");
    dot.style.display = "inline-grid";
    dot.style.placeItems = "center";
    dot.style.width = "18px";
    dot.style.height = "18px";
    dot.style.borderRadius = "9999px";
    dot.style.background = "#6366f1";
    dot.style.color = "#ffffff";
    dot.style.fontSize = "11px";
    dot.style.fontWeight = "700";
    dot.textContent = String(count);

    const label = document.createElement("span");
    label.textContent = `Moving ${count} assets`;

    badge.appendChild(dot);
    badge.appendChild(label);
  } else {
    const dot = document.createElement("span");
    dot.style.display = "inline-block";
    dot.style.width = "8px";
    dot.style.height = "8px";
    dot.style.borderRadius = "9999px";
    dot.style.background = "#6366f1";

    const label = document.createElement("span");
    const rawPrompt = typeof primaryItem?.prompt === "string" ? primaryItem.prompt.trim() : "";
    label.textContent = rawPrompt ? (rawPrompt.length > 24 ? rawPrompt.slice(0, 24) + "…" : rawPrompt) : "1 asset";

    badge.appendChild(dot);
    badge.appendChild(label);
  }

  return badge;
}

/**
 * Creates an off-screen floating drag badge element for multiple assets.
 */
export function createAssetDragBadge(dataTransfer, primaryItem, count) {
  if (typeof document === "undefined" || !dataTransfer?.setDragImage) return;

  try {
    const badge = buildAssetDragBadgeElement(primaryItem, count);
    if (!badge) return;

    document.body.appendChild(badge);
    dataTransfer.setDragImage(badge, 20, 15);

    // Clean up temporary DOM badge after browser captures snapshot
    requestAnimationFrame(() => {
      badge.remove();
    });
  } catch {
    /* ignore DOM errors during drag setup */
  }
}

if (typeof window !== "undefined") {
  window.__DRAG_CONTRACT__ = {
    setAssetDragData,
    getAssetDragData,
    setFolderDragData,
    getFolderDragData,
    clearFolderDragData,
    validateUpscalerDrop,
    validateDepthDrop,
    validatePortraitDrop,
    isFolderDescendant,
    createDropzoneFlickerGuard,
  };
}
