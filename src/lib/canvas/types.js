/**
 * Canvas board data model — the `jsonb data` shape persisted per board
 * (see `.council/canvas-board/design.md` "Data model"). Framework-free,
 * shared by the client store, the DB layer, and the API routes.
 */

export const CANVAS_STATE_VERSION = 1;

// world coord at screen origin; screen = (world - {x,y}) * zoom

