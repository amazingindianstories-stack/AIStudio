/**
 * Server-side (Node) last-frame extraction, for judging video best-of-N
 * candidates (Phase 3.2). Deliberately separate from video-frame.js, which
 * is browser-only by design — see that file's own header: "Decoding
 * server-side would need ffmpeg, which is not a dependency and is not
 * present on the Vercel runtime." That was true when it was written; this
 * module is what changes it, by adding @ffmpeg-installer/ffmpeg (a real
 * per-platform ffmpeg binary, ~30-80MB depending on platform) as an actual
 * dependency, on the user's explicit call after being shown the tradeoff.
 *
 * NOT LIVE-VERIFIED ON VERCEL. This was built and tested in a sandbox with no
 * deploy access to the real Vercel project — there is a real, unconfirmed
 * risk that the bundled ffmpeg binary pushes the queue/execute function (or
 * generate/video/status, wherever this ends up called from) over Vercel's
 * serverless function size limit, or meaningfully worsens cold-start under
 * the existing maxDuration=300 budget. Watch the first real deploy's build
 * output and function size for this specifically before trusting it in
 * production; VIDEO_BEST_OF defaults to disabled for exactly this reason —
 * see config.js's supportsVideoBestOf.
 *
 * Uses a raw child_process.execFile call to the installed ffmpeg binary
 * rather than the fluent-ffmpeg wrapper — that package is flagged
 * "no longer supported" on npm, and the actual decode work happens inside
 * the ffmpeg binary either way, so a thin direct invocation has less
 * surface to go stale than depending on an abandoned JS wrapper around it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

const EXTRACT_TIMEOUT_MS = 60_000;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath.path,
      args,
      { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`ffmpeg failed: ${err.message}\n${String(stderr).slice(-800)}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Downloads `videoUrl` and extracts its LAST frame as a JPEG.
 *
 * Downloads to a temp file first rather than piping the URL straight into
 * ffmpeg: MP4s commonly put the moov atom at the end of the file, so seeking
 * to the last frame of a remote MP4 without the whole file already local can
 * mean ffmpeg re-requesting large byte ranges repeatedly (or failing
 * outright on servers that don't support range requests) — a plain download
 * first is slower per-byte but far more predictable, and Vercel's own
 * temp-file storage (`/tmp`) is exactly what this is for.
 *
 * Returns `{mimeType, data}` (base64 JPEG) — the same shape
 * face-judge.js's judgeCandidate/judgeIdentity already expect for their
 * candidate argument, and the same shape client-side extractFrame produces
 * via its data-URL split, so no new contract for either caller.
 */
export async function extractLastFrameServer(videoUrl) {
  const dir = await mkdtemp(path.join(tmpdir(), "video-judge-"));
  const inPath = path.join(dir, "in.mp4");
  const outPath = path.join(dir, "out.jpg");
  try {
    const res = await fetch(videoUrl);
    if (!res.ok) {
      throw new Error(`Could not download candidate video for judging (http ${res.status}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(inPath, buf);

    // -sseof -1 seeks 1 SECOND before end-of-file (ffmpeg's negative-seek
    // convention), then takes exactly one frame — cheap and reliable across
    // codecs, unlike counting total frames up front. A candidate shorter than
    // 1s (shouldn't happen — every video model here has a documented minimum
    // duration well above that) would seek before frame 0, which ffmpeg
    // clamps to the start rather than erroring, so this degrades to "first
    // frame" rather than failing outright.
    await run([
      "-y",
      "-sseof", "-1",
      "-i", inPath,
      "-frames:v", "1",
      "-q:v", "3",
      outPath,
    ]);

    const jpeg = await readFile(outPath);
    return { mimeType: "image/jpeg", data: jpeg.toString("base64") };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
