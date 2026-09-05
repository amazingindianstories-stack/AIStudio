import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import {
  inspectImageDimensions,
  inspectVideoDimensions,
  measureGeneratedMedia,
  nearestSupportedAspectRatio,
} from "./generated-media-metadata.js";

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath.path, args, { timeout: 30_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("nearestSupportedAspectRatio selects by real dimensions and rejects invalid input", () => {
  const ratios = ["1:1", "4:3", "16:9", "bad"];
  assert.equal(nearestSupportedAspectRatio(1918, 1080, ratios), "16:9");
  assert.equal(nearestSupportedAspectRatio(800, 603, ratios), "4:3");
  assert.equal(nearestSupportedAspectRatio(0, 1080, ratios), undefined);
  assert.equal(nearestSupportedAspectRatio(Number.NaN, 1080, ratios), undefined);
  assert.equal(nearestSupportedAspectRatio(100, 100, []), undefined);
});

test("image inspection reads dimensions from synthetic bytes", async () => {
  const image = await sharp({
    create: { width: 321, height: 654, channels: 3, background: "#123456" },
  }).png().toBuffer();
  assert.deepEqual(await inspectImageDimensions(image), { width: 321, height: 654 });
});

test("video inspection reads a locally generated ffmpeg fixture", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "veevee-metadata-test-"));
  const fixture = path.join(directory, "fixture.mp4");
  try {
    await ffmpeg([
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=320x180:d=0.2",
      "-an",
      "-c:v", "mpeg4",
      fixture,
    ]);
    const buffer = await readFile(fixture);
    assert.deepEqual(await inspectVideoDimensions(buffer, "mp4"), { width: 320, height: 180 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("measurement records mismatches and falls back when inspection fails", async () => {
  const warnings = [];
  const portrait = await sharp({
    create: { width: 900, height: 1600, channels: 3, background: "#abcdef" },
  }).jpeg().toBuffer();
  const measured = await measureGeneratedMedia({
    buffer: portrait,
    kind: "image",
    ext: "jpg",
    model: "Nano Banana Pro",
    requestedAspectRatio: "1:1",
    generationId: "image-1",
    warn: (...args) => warnings.push(args),
  });
  assert.deepEqual(measured, { width: 900, height: 1600, aspectRatio: "9:16" });
  assert.equal(warnings[0][1].event, "generation_aspect_mismatch");

  const fallbackWarnings = [];
  const fallback = await measureGeneratedMedia({
    buffer: Buffer.from("not media"),
    kind: "image",
    ext: "png",
    model: "Nano Banana Pro",
    requestedAspectRatio: "4:3",
    generationId: "image-2",
    warn: (...args) => fallbackWarnings.push(args),
  });
  assert.deepEqual(fallback, { aspectRatio: "4:3" });
  assert.equal(fallbackWarnings[0][1].event, "generation_dimension_inspection_failed");

  const loggingFailure = await measureGeneratedMedia({
    buffer: Buffer.from("still not media"),
    kind: "video",
    ext: "mp4",
    model: "Seedance 2.0",
    requestedAspectRatio: "16:9",
    generationId: "video-1",
    warn: () => { throw new Error("logger unavailable"); },
  });
  assert.deepEqual(loggingFailure, { aspectRatio: "16:9" });
});
