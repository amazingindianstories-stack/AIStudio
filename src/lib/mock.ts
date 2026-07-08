import { promises as fs } from "fs";
import path from "path";

/** When MOCK_GENERATION=1 we fabricate placeholders so the UI can be demoed
 *  without real API keys. */

export function isMock() {
  return process.env.MOCK_GENERATION === "1";
}

const OUT_DIR = path.join(process.cwd(), "public", "generations");
const PALETTES = [
  ["#1f2937", "#0ea5e9"],
  ["#3b0764", "#ec4899"],
  ["#052e16", "#22c55e"],
  ["#431407", "#f97316"],
  ["#1e1b4b", "#6366f1"],
];

function ratioToWH(ratio: string): [number, number] {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return [1280, 720];
  const scale = 1280 / Math.max(w, h);
  return [Math.round(w * scale), Math.round(h * scale)];
}

export async function mockPlaceholder(
  id: string,
  prompt: string,
  ratio: string,
  label: string
): Promise<string> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const [w, h] = ratioToWH(ratio);
  const pal = PALETTES[Math.floor(Math.random() * PALETTES.length)];
  const short = prompt.length > 90 ? prompt.slice(0, 90) + "…" : prompt;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${pal[0]}"/>
      <stop offset="1" stop-color="${pal[1]}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="24" y="44" font-family="sans-serif" font-size="22" fill="rgba(255,255,255,0.85)">${label}</text>
  <text x="24" y="${h - 28}" font-family="sans-serif" font-size="20" fill="rgba(255,255,255,0.7)">${escapeXml(
    short
  )}</text>
</svg>`;
  const filename = `${id}.svg`;
  await fs.writeFile(path.join(OUT_DIR, filename), svg, "utf8");
  return `/generations/${filename}`;
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
