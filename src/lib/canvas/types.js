/**
 * Canvas board data model - the `jsonb data` shape persisted per board.
 * Framework-free; shared by the canvas store and the board serializer.
 */

export const CANVAS_STATE_VERSION = 1;

// world coord at screen origin; screen = (world - {x,y}) * zoom

