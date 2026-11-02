"use client";

import { useEffect } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { needsPayload } from "./payloads";

const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 30000;

/**
 * Loads a format node's payload while the node is rendered and its payload has not loaded. Off-screen nodes are
 * culled and never render, so only what is on screen or open loads. True until the payload is on the node.
 */
export function useNodePayload(node) {
  const waiting = needsPayload(node);
  const id = node?.id;
  const rev = node?.payload?.rev;
  useEffect(() => {
    if (!waiting) return undefined;
    let timer = null;
    let stopped = false;
    let delay = FIRST_RETRY_MS;
    const load = () => useCanvasStore.getState().loadPayload(id).catch(() => {
      if (stopped) return;
      timer = setTimeout(load, delay);
      delay = Math.min(MAX_RETRY_MS, delay * 2);
    });
    load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waiting, id, rev]);
  return waiting;
}
