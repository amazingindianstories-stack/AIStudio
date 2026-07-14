/**
 * Canvas board data model — the `jsonb data` shape persisted per board
 * (see `.council/canvas-board/design.md` "Data model"). Framework-free,
 * shared by the client store, the DB layer, and the API routes.
 */

export const CANVAS_STATE_VERSION = 1;

// world coord at screen origin; screen = (world - {x,y}) * zoom
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export type NodeType =
  | "rect"
  | "ellipse"
  | "triangle"
  | "diamond" // shapes
  | "text"
  | "sticky"
  | "frame"
  | "image";

export interface BaseNode {
  id: string;
  type: NodeType;
  x: number;
  y: number; // top-left, WORLD coords (absolute — see design.md Data model §1)
  w: number;
  h: number;
  opacity?: number; // 0..1, default 1
  parentId?: string | null; // id of the FRAME this node belongs to (frame membership)
  groupId?: string | null; // shared id linking a group (grouping); null = ungrouped
}

export interface ShapeNode extends BaseNode {
  type: "rect" | "ellipse" | "triangle" | "diamond";
  fill: string;
  stroke: string;
  strokeWidth: number;
  cornerRadius?: number; // rect only
}
export interface TextNode extends BaseNode {
  type: "text";
  text: string;
  fontSize: number;
  align: "left" | "center" | "right";
  color: string;
}
export interface StickyNode extends BaseNode {
  type: "sticky";
  text: string;
  fill: string;
  fontSize: number;
  color: string;
}
export interface FrameNode extends BaseNode {
  type: "frame";
  name: string;
  fill: string;
  stroke: string; // children referenced via other nodes' parentId
}
export interface ImageNode extends BaseNode {
  type: "image";
  src: string; // an /api/media/... url (never base64)
  alt?: string;
  aspectLocked: boolean;
  naturalW?: number;
  naturalH?: number;
}
export type CanvasNode = ShapeNode | TextNode | StickyNode | FrameNode | ImageNode;

export type Anchor = "auto" | "top" | "right" | "bottom" | "left" | "center";
export type Endpoint =
  | { nodeId: string; anchor: Anchor } // ATTACHED — follows the node
  | { x: number; y: number }; // FREE — fixed world point
export interface Connector {
  id: string;
  from: Endpoint;
  to: Endpoint;
  kind: "line" | "arrow"; // "arrow" = arrowhead on `to`
  stroke: string;
  strokeWidth: number;
  opacity?: number;
}

export interface CanvasState {
  version: number; // CANVAS_STATE_VERSION
  viewport: Viewport;
  nodes: CanvasNode[]; // ARRAY ORDER == Z-ORDER (index 0 = back, last = front)
  connectors: Connector[];
}

export interface CanvasBoardMeta {
  id: string;
  projectId: string;
  name: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface CanvasBoard extends CanvasBoardMeta {
  data: CanvasState;
}
