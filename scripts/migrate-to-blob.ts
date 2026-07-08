import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import { put } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/lib/db";

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "mp4") return "video/mp4";
  if (e === "webp") return "image/webp";
  return `image/${e || "png"}`;
}

async function uploadLocalFile(localPath: string): Promise<string> {
  if (!localPath.startsWith("/")) return localPath;
  const cleanPath = localPath.replace(/^\//, "");
  const absolutePath = path.join(process.cwd(), "public", cleanPath);
  
  try {
    const buffer = await fs.readFile(absolutePath);
    let key = cleanPath;
    // Strip legacy 'media/' prefix if it exists to match the new folder structure
    if (key.startsWith("media/")) {
      key = key.replace("media/", "");
    }
    const ext = path.extname(key).slice(1);
    
    console.log(`Uploading ${key}...`);
    const { url } = await put(key, buffer, {
      access: "public",
      addRandomSuffix: false,
      contentType: extToMime(ext),
    });
    return url;
  } catch (err: any) {
    console.warn(`Could not read/upload local file ${absolutePath}:`, err.message);
    return localPath; // fallback to original if failed
  }
}

async function run() {
  console.log("Migrating generations...");
  const gens = await db.select().from(schema.generations);
  
  for (const gen of gens) {
    let changed = false;
    let newUrl = gen.url;
    let newPoster = gen.poster;
    let newRefs = gen.referenceImages ? [...gen.referenceImages] : null;

    if (newUrl && newUrl.startsWith("/")) {
      newUrl = await uploadLocalFile(newUrl);
      changed = true;
    }
    
    if (newPoster && newPoster.startsWith("/")) {
      newPoster = await uploadLocalFile(newPoster);
      changed = true;
    }

    if (newRefs) {
      for (let i = 0; i < newRefs.length; i++) {
        if (newRefs[i].startsWith("/")) {
          newRefs[i] = await uploadLocalFile(newRefs[i]);
          changed = true;
        }
      }
    }

    if (changed) {
      await db
        .update(schema.generations)
        .set({ url: newUrl, poster: newPoster, referenceImages: newRefs })
        .where(eq(schema.generations.id, gen.id));
      console.log(`Updated generation ${gen.id}`);
    }
  }
  
  console.log("Migrating assets...");
  const asts = await db.select().from(schema.assets);
  for (const asset of asts) {
    let changed = false;
    let newImages = asset.images ? [...asset.images] : [];
    
    for (let i = 0; i < newImages.length; i++) {
      if (newImages[i].startsWith("/")) {
        newImages[i] = await uploadLocalFile(newImages[i]);
        changed = true;
      }
    }
    
    if (changed) {
      await db
        .update(schema.assets)
        .set({ images: newImages })
        .where(eq(schema.assets.id, asset.id));
      console.log(`Updated asset ${asset.id}`);
    }
  }

  console.log("Migration complete!");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
