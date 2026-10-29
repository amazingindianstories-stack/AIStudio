"use client";

import { useState } from "react";

/**
 * The text a contentEditable shows while someone types in it. React rewrites
 * a contentEditable's text whenever its children change, which would replace
 * what the person is typing when another editor's change to the same node
 * arrives. While editing, keep showing the text from when editing began; the
 * commit then writes the typed text onto the node's latest version.
 */
export function useTextFrozenWhileEditing(text, editing) {
  const [frozen, setFrozen] = useState({ editing, text });
  if (frozen.editing !== editing) {
    // Adjusting state during render (not in an effect) avoids one frame of the live text.
    setFrozen({ editing, text });
  }
  return editing && frozen.editing ? frozen.text : text;
}
