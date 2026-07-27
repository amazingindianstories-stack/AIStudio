import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as dotenv from "dotenv";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";

import { CANVAS_STATE_VERSION, type CanvasNode, type CanvasState } from "../src/lib/canvas/types";

dotenv.config({ path: ".env.local" });

const DEFAULT_SHIV_ROOT = "/Users/ais4/Documents/shiv_sati";
const PROJECT_NAME = "Shiv Sati";
const BOARD_NAME = "Shiv Sati Storyboard (Synced)";
const THUMB_WIDTH = 768;
const UPLOAD_CONCURRENCY = 8;

interface TrackerRow {
  sc: string;
  script_order: number;
  scene_key: string;
  heading: string;
  page_start?: number | string;
  page_end?: number | string;
  status?: string;
  progress?: string;
  storyboard_package?: string;
  latest_iteration?: string;
  still_slots?: number | string;
  shots?: number | string;
  notes?: string;
}

interface SceneStill {
  id: string;
  sourcePath: string;
  hash: string;
  mediaUrl: string;
  naturalW: number;
  naturalH: number;
}

interface SceneData {
  row: TrackerRow;
  stills: SceneStill[];
}

interface CachedImage {
  hash: string;
  mediaUrl: string;
  naturalW: number;
  naturalH: number;
}

interface SyncManifest {
  schemaVersion: 1;
  syncedAt: string;
  trackerSha256: string;
  projectId?: string;
  boardId?: string;
  boardName: string;
  sceneCount: number;
  imageCount: number;
  boardNodeCount: number;
  boardJsonBytes: number;
  images: Record<string, CachedImage>;
  scenes: Array<{
    order: number;
    sceneKey: string;
    latestIteration: string;
    status: string;
    stillCount: number;
  }>;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const forceUpload = process.argv.includes("--force-upload");
const shivRoot = path.resolve(argValue("--shiv-root") || process.env.SHIV_SATI_ROOT || DEFAULT_SHIV_ROOT);
const trackerPath = path.join(shivRoot, "storyboards", "_scene_tracker.json");
const syncRoot = path.join(shivRoot, "storyboards", "_lumina_scene_board");
const manifestPath = path.join(syncRoot, "manifest.json");

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isCanonical(row: TrackerRow): boolean {
  if (!Number.isInteger(row.script_order)) return false;
  const notes = String(row.notes || "").toLowerCase();
  return !notes.includes("not found in canonical script scene index") && !notes.includes("legacy scaffold");
}

function plannedStillCount(row: TrackerRow): number {
  for (const value of [row.still_slots, row.shots]) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return 3;
}

function pageLabel(row: TrackerRow): string {
  const start = String(row.page_start || "?");
  const end = String(row.page_end || "");
  return !end || end === start ? start : `${start}-${end}`;
}

function statusColor(status: string): string {
  if (/approved|canonical|reviewed/.test(status)) return "#62C08B";
  if (/generat|queued/.test(status)) return "#D8A84E";
  if (/review|provisional|completed/.test(status)) return "#65A7E8";
  if (/needs|blocked|reject/.test(status)) return "#E06C75";
  return "#78828D";
}

async function loadPreviousManifest(): Promise<SyncManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as SyncManifest;
  } catch {
    return undefined;
  }
}

async function listLatestStillPaths(row: TrackerRow): Promise<string[]> {
  if (!row.storyboard_package || !row.latest_iteration) return [];
  const imagesDir = path.join(shivRoot, row.storyboard_package, "iterations", row.latest_iteration, "images");
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(imagesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^shot_.+\.(png|jpe?g|webp)$/i.test(entry.name))
      .map((entry) => path.join(imagesDir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
  } catch {
    return [];
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

async function prepareStills(rows: TrackerRow[], previous: SyncManifest | undefined): Promise<SceneData[]> {
  const sources = (
    await Promise.all(
      rows.map(async (row) => (await listLatestStillPaths(row)).map((sourcePath) => ({ row, sourcePath })))
    )
  ).flat();
  let uploaded = 0;
  let reused = 0;

  const prepared = await mapLimit(sources, UPLOAD_CONCURRENCY, async ({ row, sourcePath }, index) => {
    const source = await readFile(sourcePath);
    const hash = sha256(source);
    const cacheKey = `${row.scene_key}/${row.latest_iteration}/${path.basename(sourcePath)}`;
    const cached = previous?.images?.[cacheKey];
    if (!forceUpload && cached?.hash === hash) {
      reused += 1;
      return { row, cacheKey, still: { id: path.parse(sourcePath).name, sourcePath, ...cached } };
    }

    const transformed = await sharp(source)
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const key = [
      "storyboards",
      "shiv-sati",
      String(row.script_order).padStart(3, "0"),
      row.scene_key,
      row.latest_iteration || "no-iteration",
      `${path.parse(sourcePath).name}-${hash.slice(0, 16)}.jpg`,
    ].join("/");
    const mediaUrl = `/api/media/${key}`;
    if (!dryRun) {
      const { uploadBuffer } = await import("../src/lib/storage");
      await uploadBuffer(transformed.data, key, "jpg");
    }
    uploaded += 1;
    if (!dryRun && (uploaded % 50 === 0 || index === sources.length - 1)) {
      console.log(`Uploaded ${uploaded}/${sources.length} changed storyboard images...`);
    }
    return {
      row,
      cacheKey,
      still: {
        id: path.parse(sourcePath).name,
        sourcePath,
        hash,
        mediaUrl,
        naturalW: transformed.info.width,
        naturalH: transformed.info.height,
      },
    };
  });

  const byScene = new Map<string, SceneStill[]>();
  for (const item of prepared) {
    const list = byScene.get(item.row.scene_key) || [];
    list.push(item.still);
    byScene.set(item.row.scene_key, list);
  }
  console.log(`${dryRun ? "Prepared" : "Media sync"}: ${uploaded} changed, ${reused} reused, ${sources.length} total.`);
  return rows.map((row) => ({ row, stills: byScene.get(row.scene_key) || [] }));
}

function buildBoard(scenes: SceneData[]): CanvasState {
  const nodes: CanvasNode[] = [];
  const columns = 3;
  const boardX = 120;
  const boardY = 320;
  const cardW = 1320;
  const columnGap = 84;
  const rowGap = 96;
  const pad = 32;
  const headerH = 108;
  const imageGap = 16;
  const imageW = (cardW - pad * 2 - imageGap * 2) / 3;
  const imageH = imageW / 2.39;

  nodes.push({
    id: "shiv-board-title",
    type: "text",
    x: boardX,
    y: 96,
    w: 1800,
    h: 72,
    text: "Shiv Sati Scene Board",
    fontSize: 54,
    align: "left",
    color: "#F2E8D4",
    parentId: null,
    groupId: null,
  });
  const totalStills = scenes.reduce((sum, scene) => sum + scene.stills.length, 0);
  nodes.push({
    id: "shiv-board-summary",
    type: "text",
    x: boardX,
    y: 178,
    w: 2200,
    h: 42,
    text: `${scenes.length} scenes · ${totalStills} latest-iteration stills · managed from the Shiv Sati tracker`,
    fontSize: 22,
    align: "left",
    color: "#9AA5B1",
    parentId: null,
    groupId: null,
  });

  let rowY = boardY;
  for (let rowIndex = 0; rowIndex < Math.ceil(scenes.length / columns); rowIndex += 1) {
    const rowScenes = scenes.slice(rowIndex * columns, rowIndex * columns + columns);
    const heights = rowScenes.map((scene) => {
      const tileCount = scene.stills.length || Math.min(Math.max(plannedStillCount(scene.row), 3), 12);
      return pad + headerH + Math.ceil(tileCount / 3) * imageH + Math.max(0, Math.ceil(tileCount / 3) - 1) * imageGap + pad;
    });
    const rowHeight = Math.max(...heights);

    rowScenes.forEach((scene, columnIndex) => {
      const { row, stills } = scene;
      const x = boardX + columnIndex * (cardW + columnGap);
      const frameId = `shiv-scene-${String(row.script_order).padStart(3, "0")}`;
      const status = row.status || row.progress || "not_started";
      nodes.push({
        id: frameId,
        type: "frame",
        x,
        y: rowY,
        w: cardW,
        h: rowHeight,
        name: `SC${row.script_order} · ${row.heading}`,
        fill: "#141A20",
        stroke: "#303943",
        parentId: null,
        groupId: null,
      });
      nodes.push({
        id: `${frameId}-accent`,
        type: "rect",
        x: x + pad,
        y: rowY + pad,
        w: 8,
        h: 64,
        fill: statusColor(status),
        stroke: statusColor(status),
        strokeWidth: 0,
        cornerRadius: 4,
        parentId: frameId,
        groupId: null,
      });
      nodes.push({
        id: `${frameId}-title`,
        type: "text",
        x: x + pad + 24,
        y: rowY + pad - 2,
        w: cardW - pad * 2 - 24,
        h: 40,
        text: `SC${row.script_order} · ${row.heading}`,
        fontSize: 23,
        align: "left",
        color: "#F1ECE2",
        parentId: frameId,
        groupId: null,
      });
      nodes.push({
        id: `${frameId}-meta`,
        type: "text",
        x: x + pad + 24,
        y: rowY + pad + 42,
        w: cardW - pad * 2 - 24,
        h: 30,
        text: `${status} · ${stills.length} stills · page ${pageLabel(row)} · ${row.latest_iteration || "not scaffolded"}`,
        fontSize: 16,
        align: "left",
        color: "#8F9AA6",
        parentId: frameId,
        groupId: null,
      });

      const tileCount = stills.length || Math.min(Math.max(plannedStillCount(row), 3), 12);
      for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
        const tileX = x + pad + (tileIndex % 3) * (imageW + imageGap);
        const tileY = rowY + pad + headerH + Math.floor(tileIndex / 3) * (imageH + imageGap);
        const still = stills[tileIndex];
        if (still) {
          nodes.push({
            id: `${frameId}-${still.id}`,
            type: "image",
            x: tileX,
            y: tileY,
            w: imageW,
            h: imageH,
            src: still.mediaUrl,
            alt: `SC${row.script_order} ${still.id}`,
            aspectLocked: true,
            naturalW: still.naturalW,
            naturalH: still.naturalH,
            parentId: frameId,
            groupId: null,
          });
        } else {
          nodes.push({
            id: `${frameId}-placeholder-${String(tileIndex + 1).padStart(3, "0")}`,
            type: "rect",
            x: tileX,
            y: tileY,
            w: imageW,
            h: imageH,
            fill: "#20262D",
            stroke: "#323B45",
            strokeWidth: 1,
            cornerRadius: 4,
            opacity: 0.78,
            parentId: frameId,
            groupId: null,
          });
        }
      }
    });
    rowY += rowHeight + rowGap;
  }

  return {
    version: CANVAS_STATE_VERSION,
    viewport: { x: 0, y: 0, zoom: 0.26 },
    nodes,
    connectors: [],
  };
}

async function persistBoard(data: CanvasState): Promise<{ projectId: string; boardId: string }> {
  const { getDb, schema } = await import("../src/lib/db");
  const db = await getDb();
  const now = Date.now();
  let [project] = await db.select().from(schema.projects).where(eq(schema.projects.name, PROJECT_NAME)).limit(1);
  if (!project) {
    [project] = await db
      .insert(schema.projects)
      .values({ id: randomUUID(), name: PROJECT_NAME, createdAt: now, updatedAt: now })
      .returning();
  }

  let [board] = await db
    .select()
    .from(schema.canvasBoards)
    .where(and(eq(schema.canvasBoards.projectId, project.id), eq(schema.canvasBoards.name, BOARD_NAME)))
    .limit(1);
  if (board) {
    [board] = await db
      .update(schema.canvasBoards)
      .set({ data, updatedAt: now })
      .where(eq(schema.canvasBoards.id, board.id))
      .returning();
  } else {
    [board] = await db
      .insert(schema.canvasBoards)
      .values({
        id: randomUUID(),
        projectId: project.id,
        name: BOARD_NAME,
        data,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  }
  return { projectId: project.id, boardId: board.id };
}

async function main(): Promise<void> {
  const trackerBuffer = await readFile(trackerPath);
  const rows = (JSON.parse(trackerBuffer.toString("utf8")) as TrackerRow[])
    .filter(isCanonical)
    .sort((a, b) => a.script_order - b.script_order);
  if (rows.length !== 145) {
    throw new Error(`Expected 145 canonical scenes, found ${rows.length}. Refresh the Shiv Sati tracker first.`);
  }

  const previous = await loadPreviousManifest();
  const scenes = await prepareStills(rows, previous);
  const data = buildBoard(scenes);
  const boardJsonBytes = Buffer.byteLength(JSON.stringify(data));
  if (boardJsonBytes > 2 * 1024 * 1024) {
    throw new Error(`Generated board JSON is ${boardJsonBytes} bytes, above the app's 2 MiB save limit.`);
  }

  const ids = dryRun ? {} : await persistBoard(data);
  const images: Record<string, CachedImage> = {};
  for (const scene of scenes) {
    for (const still of scene.stills) {
      const key = `${scene.row.scene_key}/${scene.row.latest_iteration}/${path.basename(still.sourcePath)}`;
      images[key] = {
        hash: still.hash,
        mediaUrl: still.mediaUrl,
        naturalW: still.naturalW,
        naturalH: still.naturalH,
      };
    }
  }
  const manifest: SyncManifest = {
    schemaVersion: 1,
    syncedAt: new Date().toISOString(),
    trackerSha256: sha256(trackerBuffer),
    ...ids,
    boardName: BOARD_NAME,
    sceneCount: scenes.length,
    imageCount: scenes.reduce((sum, scene) => sum + scene.stills.length, 0),
    boardNodeCount: data.nodes.length,
    boardJsonBytes,
    images,
    scenes: scenes.map(({ row, stills }) => ({
      order: row.script_order,
      sceneKey: row.scene_key,
      latestIteration: row.latest_iteration || "",
      status: row.status || row.progress || "not_started",
      stillCount: stills.length,
    })),
  };
  if (!dryRun) {
    await mkdir(syncRoot, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  console.log(
    JSON.stringify(
      {
        mode: dryRun ? "dry-run" : "synced",
        project: PROJECT_NAME,
        board: BOARD_NAME,
        scenes: manifest.sceneCount,
        images: manifest.imageCount,
        nodes: manifest.boardNodeCount,
        boardJsonBytes,
        ...ids,
        manifest: dryRun ? null : manifestPath,
      },
      null,
      2
    )
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
