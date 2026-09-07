// Explicit, bounded live acceptance. Each case reserves its maximum estimated
// charge before submission. An attempted case is never automatically repeated.
import dotenv from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { generateImageSeedream } from "../src/lib/providers/seedream";

async function main() {
  dotenv.config({ path: process.env.SEEDREAM_ENV_FILE, quiet: true });
  if (process.env.ARK_BASE_URL === "[SENSITIVE]") delete process.env.ARK_BASE_URL;
  if (!process.env.ARK_API_KEY || process.env.ARK_API_KEY === "[SENSITIVE]") throw new Error("Set SEEDREAM_ENV_FILE to a file containing a usable Ark key.");
  const directory = process.env.SEEDREAM_EVIDENCE_DIR || "/private/tmp/seedream-live-suite";
  await mkdir(directory, { recursive: true });
  const tiles = Array.from({ length: 64 }, (_, i) => {
    const x = 128 + (i % 8) * 480, y = 240 + Math.floor(i / 8) * 450;
    return `<g transform="translate(${x},${y})"><rect width="432" height="400" fill="${i === 27 ? "#ee8822" : "#eeeeee"}" stroke="#222" stroke-width="3"/><text x="20" y="70" font-size="48">TILE ${String(i + 1).padStart(2, "0")}</text><text x="20" y="110" font-size="18">ABCDEFG 0123456789</text>${Array.from({ length: 32 }, (_, j) => `<path d="M${20+j*10} 150v200" stroke="#123456" stroke-width="${j % 3 + 1}"/>`).join("")}</g>`;
  }).join("");
  const original = await sharp(Buffer.from(`<svg width="4096" height="4096" xmlns="http://www.w3.org/2000/svg"><rect width="4096" height="4096" fill="white"/><text x="128" y="140" font-size="80">SYNTHETIC DETAIL REFERENCE 07</text>${tiles}</svg>`)).png().toBuffer();
  const smaller = await sharp(original).resize(2048).png().toBuffer();
  const second = await sharp(Buffer.from('<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" fill="white"/><circle cx="512" cy="512" r="350" fill="#bb2233"/><text x="360" y="540" font-size="80" fill="white">ROUND</text></svg>')).png().toBuffer();
  await writeFile(`${directory}/reference-original-4096.png`, original);
  await writeFile(`${directory}/reference-2048.png`, smaller);
  await writeFile(`${directory}/reference-round.png`, second);
  const inline = (bytes) => `data:image/png;base64,${bytes.toString("base64")}`;
  const edit = "Edit image 1: change only the orange background of TILE 28 to green. Preserve the positions, all 64 numbered tiles, small lettering, line patterns, white background, and overall layout. Do not add or remove any other content.";
  const cases = [
    { name: "text-2k", resolution: "2K", aspectRatio: "1:1", prompt: "A blue ceramic teapot with fine gold floral engraving, a red silk ribbon, and a printed card reading DETAIL TEST 07. Studio photograph, pale gray table, sharp surface detail.", usd: .09 },
    { name: "text-1k", resolution: "1K", aspectRatio: "9:16", prompt: "A single blue ceramic teapot, full object visible, with fine gold floral engraving on a pale gray table. Vertical studio photograph, sharp focus.", usd: .045 },
    { name: "single-edit", resolution: "2K", aspectRatio: "1:1", prompt: edit, references: [inline(original)], usd: .09 },
    { name: "multi-composition", resolution: "2K", aspectRatio: "4:3", prompt: "Place the complete numbered grid from image 1 on the left and the red ROUND emblem from image 2 on the right. Preserve every grid number and line pattern and the word ROUND. White background, no other objects.", references: [inline(original), inline(second)], usd: .093 },
    { name: "compare-original", resolution: "2K", aspectRatio: "1:1", prompt: edit, references: [inline(original)], usd: .09 },
    { name: "compare-2048", resolution: "2K", aspectRatio: "1:1", prompt: edit, references: [inline(smaller)], usd: .09 },
  ];
  const wanted = process.argv[2] || "prepare";
  if (wanted === "prepare") { console.log({ directory, prepared: cases.map(c => c.name), maximumEstimatedUsd: .498 }); return; }
  const selected = wanted === "all" ? cases : cases.filter(c => c.name === wanted);
  if (!selected.length) throw new Error("Unknown case. Use prepare, all, or a prepared case name.");
  const ledgerPath = `${directory}/ledger.json`;
  const ledger = await readFile(ledgerPath, "utf8").then(JSON.parse).catch(e => { if(e.code === "ENOENT") return []; throw e; });
  for (const entry of selected) {
    if (ledger.some(row => row.name === entry.name)) { console.log({ name: entry.name, skipped: "already attempted; inspect the ledger" }); continue; }
    // This suite reserves less than $1; leaves >$4 for app acceptance and any
    // earlier attempts within the user's $5 TOTAL session authorization.
    if (ledger.reduce((sum, row) => sum + row.reservedUsd, 0) + entry.usd > 1) throw new Error("Live suite budget exhausted.");
    const row = { name: entry.name, reservedUsd: entry.usd, startedAt: new Date().toISOString(), status: "submitted" };
    ledger.push(row); await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
    const start = Date.now();
    try {
      const bytes = await generateImageSeedream(entry, { signal: AbortSignal.timeout(240000) });
      await writeFile(`${directory}/${entry.name}.png`, bytes);
      const { width, height, format } = await sharp(bytes).metadata();
      Object.assign(row, { status: "succeeded", width, height, format, latencyMs: Date.now() - start });
    } catch (error) { Object.assign(row, { status: "failed", error: error.message, latencyMs: Date.now() - start }); }
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(row);
    if (row.status === "failed") throw new Error("Stopped after failure. No request was automatically repeated.");
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
