import { useEffect, useState } from "react";
import { isBoardTarget, isTypingTarget } from "@/lib/canvas/shortcuts";
import { modalOpen } from "@/lib/canvas/use-board-clipboard";

/** Whether Space at `target` is the board's pan key: focus on the board (or nowhere), not a field, a dialog, or a control Space activates. */
export function spaceStartsPan(target) {
  if (modalOpen() || isTypingTarget(target) || !isBoardTarget(target)) return false;
  return target?.tagName !== "BUTTON";
}

/** True while Space is held for panning; released on keyup and when the window loses focus. */
export function useSpaceHeld() {
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.code === "Space" && !e.repeat && spaceStartsPan(e.target)) setSpaceHeld(true);
    };
    const onKeyUp = (e) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    // The keyup goes to another window when focus leaves while Space is down.
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return spaceHeld;
}
