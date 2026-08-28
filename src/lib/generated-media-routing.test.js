import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queueRoute = readFileSync("src/app/api/queue/execute/route.js", "utf8");
const videoStatusRoute = readFileSync("src/app/api/generate/video/status/route.js", "utf8");

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
  const bestOf = between(videoStatusRoute, "async function resolveVideoBestOf", "export async function GET");
  const omni = between(videoStatusRoute, "if (isOmniModel(item.model)) {", "// Higgsfield → MCP");
  const provider = between(videoStatusRoute, "// Higgsfield → MCP", "if (result.status === \"failed\")");
  assert.match(bestOf, /saveFromUrlWithMetadata\(winner\.videoUrl/);
  assert.match(bestOf, /aspectRatio,/);
  assert.match(omni, /saveBase64WithMetadata\(result\.videoBase64/);
  assert.match(omni, /aspectRatio: url\.aspectRatio/);
  assert.match(provider, /saveFromUrlWithMetadata\(videoUrl/);
  assert.match(provider, /aspectRatio,/);
});

test("remote video URLs remain the fallback when local persistence fails", () => {
  assert.match(videoStatusRoute, /let localUrl = winner\.videoUrl;[\s\S]*?catch \{\s*\/\/ fall back to the remote url/);
  assert.match(videoStatusRoute, /let localUrl = videoUrl;[\s\S]*?catch \{\s*\/\/ fall back to the remote url/);
});
