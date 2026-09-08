/**
 * Real, deterministic ffmpeg round-trip — not mocked. video-frame-server.js
 * exists specifically to add a genuine ffmpeg dependency to the deploy (see
 * its own header for the unverified-on-Vercel risk that decision carries),
 * so a test that stubs ffmpeg out would verify nothing about the actual
 * risk this module exists to take on. Generates its own tiny local test
 * video with ffmpeg itself (no network, no fixture file to keep in the
 * repo) and serves it from a local HTTP server, exercising the exact
 * download → temp-file → ffmpeg → base64 path resolveVideoBestOf uses in
 * the video status route.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { extractLastFrameServer } from "./video-frame-server";

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath.path, args, { timeout: 30_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Serves `filePath` on 127.0.0.1 for the duration of `run`, then tears the
 *  server down regardless of outcome. */
async function withLocalFileServer(filePath, run) {
  const server = createServer(async (_req, res) => {
    try {
      const buf = await readFile(filePath);
      res.writeHead(200, { "Content-Type": "video/mp4" });
      res.end(buf);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}/test.mp4`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("extractLastFrameServer: downloads a video and returns a base64 JPEG last frame", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-frame-test-"));
  const videoPath = path.join(dir, "src.mp4");
  try {
    // A short, tiny synthetic test video — ffmpeg's own lavfi testsrc, no
    // external fixture needed. 1s is enough to exercise the -sseof -1 seek.
    await run([
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=duration=1:size=64x64:rate=5",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);

    const frame = await withLocalFileServer(videoPath, (url) => extractLastFrameServer(url));

    assert.equal(frame.mimeType, "image/jpeg");
    assert.equal(typeof frame.data, "string");
    assert.ok(frame.data.length > 0, "expected non-empty base64 payload");
    // A valid JPEG starts with the SOI marker (FF D8) — cheap sanity check
    // that this is real image data, not an empty/corrupt file.
    const bytes = Buffer.from(frame.data, "base64");
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("extractLastFrameServer: a video shorter than the 1s seek window still returns a frame (clamped to start, not an error)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "video-frame-test-short-"));
  const videoPath = path.join(dir, "short.mp4");
  try {
    await run([
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=duration=0.3:size=64x64:rate=5",
      "-pix_fmt", "yuv420p",
      videoPath,
    ]);

    const frame = await withLocalFileServer(videoPath, (url) => extractLastFrameServer(url));
    assert.equal(frame.mimeType, "image/jpeg");
    assert.ok(frame.data.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("extractLastFrameServer: a download failure (404) throws a clear, actionable error", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => extractLastFrameServer(`http://127.0.0.1:${port}/missing.mp4`),
      /could not download/i
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
