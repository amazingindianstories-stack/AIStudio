"use client";

import { useState } from "react";

/**
 * `value` as it was when `active` became true, for as long as it stays true.
 * A contentEditable shows the text from when editing began (React rewrites
 * its text whenever its children change, which would replace what is being
 * typed), and the commit writes the typed text onto the node's latest version
 * only when it differs from that starting text. An image being cropped is
 * shown as it was when the crop began, so another person's change does not
 * move it under the crop; the crop is applied onto its latest version.
 */
export function useFrozenWhile(value, active) {
  const [frozen, setFrozen] = useState({ active, value });
  if (frozen.active !== active) {
    // Adjusting state during render (not in an effect) avoids one frame of the live value.
    setFrozen({ active, value });
  }
  return active && frozen.active ? frozen.value : value;
}
