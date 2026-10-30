/**
 * Named diagram styling themes for basic and diagramming shapes.
 * Picking a theme in the shapes panel sets the default fill, stroke,
 * strokeWidth and text color applied to newly created shapes, and can
 * also be applied in bulk to the current shape selection.
 */

export const DIAGRAM_THEMES = [
  {
    id: "default",
    name: "Studio Dark",
    fill: "rgba(255,255,255,0.06)",
    stroke: "rgba(255,255,255,0.55)",
    strokeWidth: 2,
    color: "#ffffff",
  },
  {
    id: "blueprint",
    name: "Blueprint",
    fill: "#102a43",
    stroke: "#62b0e8",
    strokeWidth: 2,
    color: "#e6f6ff",
  },
  {
    id: "emerald",
    name: "Emerald",
    fill: "#0f2e22",
    stroke: "#52b788",
    strokeWidth: 2,
    color: "#d8f3dc",
  },
  {
    id: "amber",
    name: "Warm Amber",
    fill: "#2d2112",
    stroke: "#e3c56a",
    strokeWidth: 2,
    color: "#fff3d1",
  },
  {
    id: "pastel",
    name: "Pastel",
    fill: "#e8f4f8",
    stroke: "#4a7c9b",
    strokeWidth: 2,
    color: "#102a43",
  },
  {
    id: "monochrome",
    name: "High Contrast",
    fill: "#ffffff",
    stroke: "#111827",
    strokeWidth: 2,
    color: "#111827",
  },
];

const THEME_STORAGE_KEY = "veevee:canvas:diagram-theme:v1";

export function getDiagramTheme(themeId) {
  return DIAGRAM_THEMES.find((t) => t.id === themeId) ?? DIAGRAM_THEMES[0];
}

export function loadDiagramThemeId() {
  if (typeof window === "undefined") return "default";
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (raw && DIAGRAM_THEMES.some((t) => t.id === raw)) return raw;
  } catch {
    /* ignore storage errors */
  }
  return "default";
}

export function saveDiagramThemeId(themeId) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    /* ignore storage errors */
  }
}
