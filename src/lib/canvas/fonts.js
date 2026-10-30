/**
 * The board font library: the fonts a text box, sticky or shape can use
 * (`fontFamily`), mirrored by FONT_FAMILY in backend/apps/canvas/serialization.py.
 * Each font is self-hosted through next/font (src/components/canvas/board-fonts.js)
 * as a CSS variable, and the browser downloads a font only once an object on the
 * board uses it. An id the catalogue does not know (a newer client's font) is
 * kept in the board and renders in the default font.
 */
export const FONT_FAMILY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DEFAULT_FONT = "inter";

/** `group` orders the picker; every Latin font here also covers Cyrillic. */
export const BOARD_FONTS = [
  { id: "inter", name: "Inter", group: "sans", fallback: "sans-serif" },
  { id: "roboto", name: "Roboto", group: "sans", fallback: "sans-serif" },
  { id: "open-sans", name: "Open Sans", group: "sans", fallback: "sans-serif" },
  { id: "montserrat", name: "Montserrat", group: "sans", fallback: "sans-serif" },
  { id: "noto-sans", name: "Noto Sans", group: "sans", fallback: "sans-serif" },
  { id: "pt-sans", name: "PT Sans", group: "sans", fallback: "sans-serif" },
  { id: "fira-sans", name: "Fira Sans", group: "sans", fallback: "sans-serif" },
  { id: "rubik", name: "Rubik", group: "sans", fallback: "sans-serif" },
  { id: "raleway", name: "Raleway", group: "sans", fallback: "sans-serif" },
  { id: "ubuntu", name: "Ubuntu", group: "sans", fallback: "sans-serif" },
  { id: "source-sans", name: "Source Sans 3", group: "sans", fallback: "sans-serif" },
  { id: "ibm-plex-sans", name: "IBM Plex Sans", group: "sans", fallback: "sans-serif" },
  { id: "nunito", name: "Nunito", group: "sans", fallback: "sans-serif" },
  { id: "manrope", name: "Manrope", group: "sans", fallback: "sans-serif" },
  { id: "oswald", name: "Oswald", group: "sans", fallback: "sans-serif" },
  { id: "exo-2", name: "Exo 2", group: "sans", fallback: "sans-serif" },
  { id: "comfortaa", name: "Comfortaa", group: "sans", fallback: "sans-serif" },
  { id: "noto-serif", name: "Noto Serif", group: "serif", fallback: "serif" },
  { id: "pt-serif", name: "PT Serif", group: "serif", fallback: "serif" },
  { id: "merriweather", name: "Merriweather", group: "serif", fallback: "serif" },
  { id: "lora", name: "Lora", group: "serif", fallback: "serif" },
  { id: "playfair", name: "Playfair Display", group: "serif", fallback: "serif" },
  { id: "eb-garamond", name: "EB Garamond", group: "serif", fallback: "serif" },
  { id: "roboto-slab", name: "Roboto Slab", group: "serif", fallback: "serif" },
  { id: "ibm-plex-mono", name: "IBM Plex Mono", group: "mono", fallback: "monospace" },
  { id: "jetbrains-mono", name: "JetBrains Mono", group: "mono", fallback: "monospace" },
  { id: "roboto-mono", name: "Roboto Mono", group: "mono", fallback: "monospace" },
  { id: "caveat", name: "Caveat", group: "hand", fallback: "cursive" },
  { id: "pacifico", name: "Pacifico", group: "hand", fallback: "cursive" },
  { id: "lobster", name: "Lobster", group: "hand", fallback: "cursive" },
  { id: "noto-sans-jp", name: "Noto Sans JP", group: "cjk", fallback: "sans-serif" },
  { id: "noto-sans-sc", name: "Noto Sans SC", group: "cjk", fallback: "sans-serif" },
  { id: "noto-sans-tc", name: "Noto Sans TC", group: "cjk", fallback: "sans-serif" },
  { id: "noto-sans-kr", name: "Noto Sans KR", group: "cjk", fallback: "sans-serif" },
];

export const FONT_GROUPS = [
  { id: "sans", name: "Sans serif" },
  { id: "serif", name: "Serif" },
  { id: "mono", name: "Monospace" },
  { id: "hand", name: "Handwriting and display" },
  { id: "cjk", name: "Chinese, Japanese and Korean" },
];

const BY_ID = new Map(BOARD_FONTS.map((font) => [font.id, font]));

export function boardFont(id) {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_FONT);
}

/** The CSS variable next/font sets for a font id; Inter is the page's own font. */
export function fontVariable(id) {
  return id === DEFAULT_FONT ? "--font-sans" : `--board-font-${id}`;
}

/** The CSS `font-family` for an object's `fontFamily`; undefined keeps the page font. */
export function fontFamilyCss(id) {
  if (!id || !BY_ID.has(id)) return undefined;
  const font = BY_ID.get(id);
  return `var(${fontVariable(id)}), ${font.fallback}`;
}
