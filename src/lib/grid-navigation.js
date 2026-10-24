/**
 * Spatial Grid Navigation for Asset Library (Masonry Layout)
 */

function relativeHeight(aspectRatio) {
  const [w, h] = String(aspectRatio ?? "").split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return 9 / 16;
  return h / w;
}

/**
 * Computes the estimated vertical center of an item within its column.
 * `gap` is the space between cards, in column widths.
 */
function getColumnItemCenter(column, index, gap) {
  let top = 0;
  for (let i = 0; i < index; i++) {
    top += relativeHeight(column[i]?.aspectRatio) + gap;
  }
  return top + relativeHeight(column[index]?.aspectRatio) / 2;
}

/**
 * Finds the next visual neighbor ID when navigating spatially with arrow keys
 * across packed masonry columns.
 *
 * @param {Array<Array<Object>>} columns - 2D array of columns from packColumns
 * @param {string|null} currentId - Currently focused item ID
 * @param {'up'|'down'|'left'|'right'|'home'|'end'} direction
 * @param {Array<Object>} [items] - Flat list of all items
 * @param {number} [gap] - Space between cards, in column widths
 * @returns {string|null} Next item ID to focus
 */
export function getNextGridFocus(columns, currentId, direction, items = [], gap = 0.06) {
  if (!items || items.length === 0) return null;
  if (!columns || columns.length === 0) return items[0]?.id || null;

  if (direction === "home") return items[0]?.id || null;
  if (direction === "end") return items[items.length - 1]?.id || null;

  if (!currentId) return items[0]?.id || null;

  // Locate current item's column and row index
  let currentColIdx = -1;
  let currentRowIdx = -1;

  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci];
    const ri = col.findIndex((item) => item.id === currentId);
    if (ri !== -1) {
      currentColIdx = ci;
      currentRowIdx = ri;
      break;
    }
  }

  if (currentColIdx === -1) {
    // Current ID not in columns (e.g. freshly paged or filtered)
    return items[0]?.id || null;
  }

  const currentCol = columns[currentColIdx];

  if (direction === "up") {
    if (currentRowIdx > 0) {
      return currentCol[currentRowIdx - 1].id;
    }
    return currentId;
  }

  if (direction === "down") {
    if (currentRowIdx < currentCol.length - 1) {
      return currentCol[currentRowIdx + 1].id;
    }
    return currentId;
  }

  if (direction === "left") {
    if (columns.length === 1) {
      if (currentRowIdx > 0) return currentCol[currentRowIdx - 1].id;
      return currentId;
    }
    if (currentColIdx === 0) return currentId;
    const targetCol = columns[currentColIdx - 1];
    if (!targetCol || targetCol.length === 0) return currentId;

    const currentCenter = getColumnItemCenter(currentCol, currentRowIdx, gap);
    let bestId = targetCol[0].id;
    let minDiff = Infinity;

    for (let ri = 0; ri < targetCol.length; ri++) {
      const targetCenter = getColumnItemCenter(targetCol, ri, gap);
      const diff = Math.abs(targetCenter - currentCenter);
      if (diff < minDiff) {
        minDiff = diff;
        bestId = targetCol[ri].id;
      }
    }
    return bestId;
  }

  if (direction === "right") {
    if (columns.length === 1) {
      if (currentRowIdx < currentCol.length - 1) return currentCol[currentRowIdx + 1].id;
      return currentId;
    }
    if (currentColIdx >= columns.length - 1) return currentId;
    const targetCol = columns[currentColIdx + 1];
    if (!targetCol || targetCol.length === 0) return currentId;

    const currentCenter = getColumnItemCenter(currentCol, currentRowIdx, gap);
    let bestId = targetCol[0].id;
    let minDiff = Infinity;

    for (let ri = 0; ri < targetCol.length; ri++) {
      const targetCenter = getColumnItemCenter(targetCol, ri, gap);
      const diff = Math.abs(targetCenter - currentCenter);
      if (diff < minDiff) {
        minDiff = diff;
        bestId = targetCol[ri].id;
      }
    }
    return bestId;
  }

  return currentId;
}
