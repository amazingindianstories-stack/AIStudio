/**
 * Store actions for board-wide view settings everyone shares: the background
 * color and the start view. Spread into the board store (canvas-store.js);
 * each change goes through `mutateGraph`, so it is one undo step, saves with
 * the per-object save path, and does nothing for people who cannot edit. The
 * server also refuses start view changes from anyone below co-owner.
 */
import { canShareRole } from "../board-access";
import { clampZoom } from "./geometry";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** `present` with `key` of its settings set to `value` (null removes it). */
export function withSetting(present, key, value) {
  const settings = { ...(present.settings ?? {}) };
  if (value == null) delete settings[key];
  else settings[key] = value;
  const next = { ...present };
  if (Object.keys(settings).length) next.settings = settings;
  else delete next.settings;
  return next;
}

export function boardViewActions(set, get, { mutateGraph }) {
  const writeSetting = (key, value) => {
    const current = get().history.present.settings?.[key] ?? null;
    if (JSON.stringify(current) === JSON.stringify(value ?? null)) return;
    mutateGraph(set, get, (present) => withSetting(present, key, value));
  };

  return {
    /** Sets the board background for everyone; null returns to the default. */
    setBoardBackground: (color) => {
      if (color != null && !HEX_COLOR.test(color)) return;
      writeSetting("background", color ? color.toLowerCase() : null);
    },

    /** Owners and co-owners: newly invited people open at `view` (default: the current view). */
    setStartView: (view = get().history.present.viewport) => {
      if (!canShareRole(get().boardRole)) return;
      if (![view?.x, view?.y, view?.zoom].every(Number.isFinite) || view.zoom <= 0) return;
      writeSetting("startView", { x: view.x, y: view.y, zoom: clampZoom(view.zoom) });
    },

    clearStartView: () => {
      if (!canShareRole(get().boardRole)) return;
      writeSetting("startView", null);
    },
  };
}
