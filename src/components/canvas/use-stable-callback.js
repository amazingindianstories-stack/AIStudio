import { useCallback, useRef } from "react";

/**
 * A function with a fixed identity that always calls the latest `fn`, so memoized children that
 * receive it as a prop do not re-render when only the closure behind it changed.
 */
export function useStableCallback(fn) {
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback((...args) => latest.current(...args), []);
}

/** `list`, or the previous array when it holds the same items in the same order. */
export function useStableList(list) {
  const kept = useRef(list);
  const previous = kept.current;
  if (previous !== list && (previous.length !== list.length || previous.some((item, index) => item !== list[index]))) kept.current = list;
  return kept.current;
}
