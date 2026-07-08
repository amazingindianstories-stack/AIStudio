import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { put } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { uploadBuffer } from "../src/lib/storage";

// In order to download from Vercel Blob, we just need to fetch the public URL
async function fetchFromVercelBlob(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Failed to fetch ${url} - Status: ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`Error fetching ${url}:`, err);
    return null;
  }
}

async function migrateUrl(oldUrl: string): Promise<string> {
  // If it's a Vercel Blob URL (or absolute http URL to vercel blob)
  if (oldUrl.includes("vercel-storage.com")) {
    console.log(`Migrating: ${oldUrl}`);
    const buffer = await fetchFromVercelBlob(oldUrl);
    if (!buffer) return oldUrl; // fallback if failed

    // Extract key and extension
    const urlParts = new URL(oldUrl);
    let key = urlParts.pathname.replace(/^\//, "");
    
    // Some old keys might have a hash in the filename, we can just keep the key
    const ext = key.split('.').pop() || "png";
    
    try {
      const newUrl = await uploadBuffer(buffer, key, ext);
      console.log(` -> Success: ${newUrl}`);
      return newUrl;
    } catch (err) {
      console.error(` -> Failed to upload to S3:`, err);
      return oldUrl;
    }
  }
  return oldUrl; // unchanged
}

async function run() {
  const { db, schema } = await import("../src/lib/db");
  console.log("Migrating generations from Vercel Blob to S3...");
  
  const gens = await db.select().from(schema.generations);
  let genUpdated = 0;
  
  for (const gen of gens) {
    let changed = false;
    let newUrl = gen.url;
    let newPoster = gen.poster;
    let newRefs = gen.referenceImages ? [...gen.referenceImages] : null;

    if (newUrl && newUrl.includes("vercel-storage.com")) {
      newUrl = await migrateUrl(newUrl);
      changed = true;
    }
    
    if (newPoster && newPoster.includes("vercel-storage.com")) {
      newPoster = await migrateUrl(newPoster);
      changed = true;
    }

    if (newRefs) {
      for (let i = 0; i < newRefs.length; i++) {
        if (newRefs[i] && newRefs[i].includes("vercel-storage.com")) {
          newRefs[i] = await migrateUrl(newRefs[i]);
          changed = true;
        }
      }
    }

    if (changed) {
      await db
        .update(schema.generations)
        .set({ url: newUrl, poster: newPoster, referenceImages: newRefs })
        .where(eq(schema.generations.id, gen.id));
      genUpdated++;
    }
  }
  console.log(`Updated ${genUpdated} generations.`);
  
  console.log("Migrating assets from Vercel Blob to S3...");
  const asts = await db.select().from(schema.assets);
  let astUpdated = 0;
  
  for (const asset of asts) {
    let changed = false;
    let newImages = asset.images ? [...asset.images] : [];
    
    for (let i = 0; i < newImages.length; i++) {
      if (newImages[i] && newImages[i].includes("vercel-storage.com")) {
        newImages[i] = await migrateUrl(newImages[i]);
        changed = true;
      }
    }
    
    if (changed) {
      await db
        .update(schema.assets)
        .set({ images: newImages })
        .where(eq(schema.assets.id, asset.id));
      astUpdated++;
    }
  }
  console.log(`Updated ${astUpdated} assets.`);

  console.log("Migration complete!");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
