export const VALID_FOLDER_COLORS = new Set([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
]);

export const FOLDER_COLOR_OPTIONS = [
  { id: "default", label: "Default", textClass: "text-amber-400/90", dotClass: "bg-amber-400" },
  { id: "gray", label: "Gray", textClass: "text-neutral-400", dotClass: "bg-neutral-400" },
  { id: "red", label: "Red", textClass: "text-rose-400", dotClass: "bg-rose-400" },
  { id: "orange", label: "Orange", textClass: "text-orange-400", dotClass: "bg-orange-400" },
  { id: "yellow", label: "Yellow", textClass: "text-yellow-400", dotClass: "bg-yellow-400" },
  { id: "green", label: "Green", textClass: "text-emerald-400", dotClass: "bg-emerald-400" },
  { id: "blue", label: "Blue", textClass: "text-sky-400", dotClass: "bg-sky-400" },
  { id: "purple", label: "Purple", textClass: "text-purple-400", dotClass: "bg-purple-400" },
  { id: "pink", label: "Pink", textClass: "text-pink-400", dotClass: "bg-pink-400" },
];

export function normalizeFolderColor(color) {
  if (!color || color === "default") return null;
  const lower = String(color).toLowerCase().trim();
  if (VALID_FOLDER_COLORS.has(lower)) return lower;
  return null;
}

export function isValidFolderColor(color) {
  if (color === null || color === undefined || color === "" || color === "default") return true;
  return VALID_FOLDER_COLORS.has(String(color).toLowerCase().trim());
}

export function getFolderColorClass(color) {
  const norm = normalizeFolderColor(color);
  switch (norm) {
    case "gray":
      return "text-neutral-400";
    case "red":
      return "text-rose-400";
    case "orange":
      return "text-orange-400";
    case "yellow":
      return "text-yellow-400";
    case "green":
      return "text-emerald-400";
    case "blue":
      return "text-sky-400";
    case "purple":
      return "text-purple-400";
    case "pink":
      return "text-pink-400";
    default:
      return "text-amber-400/90";
  }
}
