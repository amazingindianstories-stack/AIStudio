export const WIREFRAMES = [
  { name: "Mobile screen", type: "frame", w: 390, h: 844 },
  { name: "Tablet screen", type: "frame", w: 768, h: 1024 },
  { name: "Desktop screen", type: "frame", w: 1440, h: 900 },
  { name: "Button", w: 160, h: 48, text: "Continue", radius: 8 },
  { name: "Text input", w: 280, h: 48, text: "Enter text…", radius: 6 },
  { name: "Search", w: 280, h: 48, text: "⌕ Search", radius: 24 },
  { name: "Checkbox", w: 160, h: 32, text: "☐ Option" },
  { name: "Radio button", w: 160, h: 32, text: "◯ Option" },
  { name: "Toggle", w: 100, h: 36, text: "● On", radius: 18 },
  { name: "Dropdown", w: 240, h: 48, text: "Select ▾", radius: 6 },
  { name: "Navigation", w: 360, h: 56, text: "Home     About     Contact" },
  { name: "Image placeholder", w: 280, h: 180, text: "▧ Image" },
  { name: "Avatar", type: "ellipse", w: 56, h: 56, text: "☺" },
  { name: "Heading", w: 320, h: 64, text: "Heading", fontSize: 32 },
  { name: "Paragraph", w: 320, h: 110, text: "A short description of this section and what the user can do here." },
  { name: "Card", w: 280, h: 180, text: "Card title\n\nDescription\n\nView details →", radius: 12 },
  { name: "Divider", w: 320, h: 4, text: "" },
  { name: "Home icon", w: 40, h: 40, text: "⌂" },
  { name: "Menu icon", w: 40, h: 40, text: "☰" },
  { name: "Close icon", w: 40, h: 40, text: "×" },
  { name: "Settings icon", w: 40, h: 40, text: "⚙" },
];

export function wireframeNode(item, center, parentId = null) {
  const base = { id: crypto.randomUUID(), type: item.type || "rect", x: center.x - item.w / 2, y: center.y - item.h / 2, w: item.w, h: item.h, parentId, groupId: null, fill: "#f8fafc", stroke: "#64748b", strokeWidth: 1 };
  if (base.type === "frame") return { ...base, name: item.name };
  return { ...base, text: item.text, color: "#0f172a", fontSize: item.fontSize || 16, align: "center", ...(item.radius ? { cornerRadius: item.radius } : {}) };
}
