/**
 * The system clipboard side of board copy and paste. Copying objects also
 * puts their text and a board marker on the system clipboard, so a paste can
 * tell which was copied last: board objects (pasted from the board's own
 * clipboard) or cells from a spreadsheet (pasted as one sticky per cell).
 */
import { parseTsv } from "./stickies";

export const BOARD_COPY_ATTRIBUTE = "data-veevee-board-copy";

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** What a board copy of `nodes` puts on the system clipboard: their text, and HTML with the board marker. */
export function boardClipboardData(nodes) {
  const text = nodes.map((node) => node.text ?? node.name ?? "").filter(Boolean).join("\n");
  return {
    "text/plain": text,
    "text/html": `<div ${BOARD_COPY_ATTRIBUTE}="">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`,
  };
}

export function isBoardCopy(html) {
  return Boolean(html) && html.includes(BOARD_COPY_ATTRIBUTE);
}

/**
 * The cells a spreadsheet put on the clipboard, as rows of texts, or null
 * when the clipboard holds no cells. An HTML table wins (a one-column copy has
 * no tab in its text); otherwise tab-separated text. `parseHtml` turns HTML
 * into a Document (DOMParser in the browser).
 */
export function clipboardCells(html, text, parseHtml = defaultParseHtml) {
  if (html && /<table[\s>]/i.test(html) && !isBoardCopy(html)) {
    // A line break inside a cell stays one.
    const table = parseHtml(html.replace(/<br\s*\/?>/gi, "\n"))?.querySelector("table");
    if (table) {
      const rows = [...table.querySelectorAll("tr")].map((row) =>
        [...row.querySelectorAll("td, th")].map((cell) => (cell.textContent ?? "").trim()));
      if (rows.some((row) => row.some(Boolean))) return rows;
    }
  }
  return text ? parseTsv(text) : null;
}

function defaultParseHtml(html) {
  return typeof DOMParser === "undefined" ? null : new DOMParser().parseFromString(html, "text/html");
}
