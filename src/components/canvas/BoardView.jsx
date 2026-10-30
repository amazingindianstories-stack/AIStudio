"use client";

import { BOARD_FONT_VARIABLES } from "./board-fonts";

// Set once, before the board first lays out text, and on the root element so menus portaled outside the board see them too.
document.documentElement.classList.add(...BOARD_FONT_VARIABLES.split(" "));

export { CanvasView } from "./CanvasView";
