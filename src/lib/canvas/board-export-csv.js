/** CSV export of the text on a board, written from board data. */
import { csvCell } from "./stickies";
import { exportNodes } from "./board-export-svg";

const TEXT_TYPES = new Set(["sticky", "text", "rect", "ellipse", "triangle", "diamond", "shape"]);

/** One row per object that carries text (or a frame/diagram name), in board order. */
export function boardTextCsv(state, scope = {}) {
  const lines = [["Type", "Text"].join(",")];
  for (const node of exportNodes(state, scope)) {
    const text = TEXT_TYPES.has(node.type) ? node.text : node.name;
    if (typeof text !== "string" || !text) continue;
    lines.push([node.type === "shape" ? node.shape : node.type, text].map(csvCell).join(","));
  }
  return lines.length > 1 ? `﻿${lines.join("\r\n")}\r\n` : null;
}
