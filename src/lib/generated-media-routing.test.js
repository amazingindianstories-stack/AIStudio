import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const queueRoute = readFileSync("src/app/api/queue/execute/route.js", "utf8");
const videoStatusService = readFileSync("src/lib/video-status-advancement.js", "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing end marker after ${start}: ${end}`);
  return source.slice(from, to);
}

test("Gemini, Higgsfield, and Kling image successes use measured persistence", () => {
  const higgsfield = between(
    queueRoute,
    "} else if (isHiggsfieldModel(model)) {",
    "} else if (isKlingModel(model)) {"
  );
  const kling = between(
    queueRoute,
    "} else if (isKlingModel(model)) {",
    "// Context engineering:"
  );
  const gemini = between(
    queueRoute,
    "// Context engineering:",
    "const done = {"
  );
  assert.match(higgsfield, /saveFromUrlWithMetadata/);
  assert.match(kling, /saveBufferWithMetadata\(bytes/);
  assert.match(gemini, /saveBase64WithMetadata\(base64/);
  for (const branch of [higgsfield, kling, gemini]) {
    assert.match(branch, /aspectRatioOut = saved\.aspectRatio/);
  }
});

test("Omni, provider URL, and best-of video successes use measured persistence", () => {
  const bestOf = between(videoStatusService, "async function resolveVideoBestOf", "async function advanceOmni");
  const omni = between(videoStatusService, "async function advanceOmni", "async function advanceStandard");
  const provider = between(videoStatusService, "async function advanceStandard", "/**\n * Shared browser\/cron");
  assert.match(bestOf, /saveFromUrlWithMetadata\(url/);
  assert.match(bestOf, /aspectRatio,/);
  assert.match(omni, /saveBase64WithMetadata\(result\.videoBase64/);
  assert.match(omni, /aspectRatio: saved\.aspectRatio/);
  assert.match(provider, /saveFromUrlWithMetadata\(videoUrl/);
  assert.match(provider, /aspectRatio/);
});

test("remote video URLs remain the fallback when local persistence fails", () => {
  assert.match(videoStatusService, /let url = winner\.videoUrl;[\s\S]*?catch \{[\s\S]*?provider URL remains usable/);
  assert.match(videoStatusService, /let url = videoUrl;[\s\S]*?catch \{[\s\S]*?Keep the provider URL/);
});

test("Gemini renders and persists the requested resolution without supersampling", () => {
  assert.doesNotMatch(queueRoute, /SUPERSAMPLE|NEXT_IMAGE_SIZE|halveForDelivery/);
  const gemini = between(queueRoute, "// Context engineering:", "const done = {");
  assert.match(gemini, /imageSize: requestedSize/);
  assert.match(gemini, /boundedBestOf\(process\.env\.FACE_BEST_OF, requestedSize\)/);
});
