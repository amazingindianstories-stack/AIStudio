"use client";

import { useEffect, useId } from "react";

// Open confirmation layers, oldest first. Parent surfaces ask this registry
// whether a child layer is open instead of scanning the document for markup.
const layers = [];

export function isTopModal(id) {
  return layers.length > 0 && layers[layers.length - 1] === id;
}

export function hasModalLayer() {
  return layers.length > 0;
}

export function useModalLayer(open) {
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    layers.push(id);
    return () => {
      const at = layers.lastIndexOf(id);
      if (at >= 0) layers.splice(at, 1);
    };
  }, [open, id]);
  return id;
}
