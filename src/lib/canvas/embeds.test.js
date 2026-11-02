import test from "node:test";
import assert from "node:assert/strict";
import { classifyEmbed, embedFromIframe, embedFromUrl } from "./embeds";

test("page links become the provider's embed address", () => {
  const cases = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "https://www.youtube.com/embed/dQw4w9WgXcQ?start=42"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871"],
    ["https://vimeo.com/76979871/abcdef1234", "https://player.vimeo.com/video/76979871?h=abcdef1234"],
    ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x", "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"],
    ["https://www.loom.com/share/0123456789abcdef0123456789abcdef", "https://www.loom.com/embed/0123456789abcdef0123456789abcdef"],
  ];
  for (const [page, embed] of cases) assert.equal(embedFromUrl(page)?.src, embed, page);
});

test("a provider's kind tells video from audio", () => {
  assert.equal(embedFromUrl("https://youtu.be/dQw4w9WgXcQ").kind, "video");
  assert.equal(embedFromUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC").kind, "audio");
});

test("other sites, other schemes and look-alike hosts are refused", () => {
  for (const url of [
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "javascript:alert(1)",
    "https://www.youtube.com.evil.example/embed/dQw4w9WgXcQ",
    "https://evil.example/https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://user:pw@www.youtube.com/embed/dQw4w9WgXcQ",
  ]) {
    assert.equal(embedFromUrl(url), null, url);
    assert.equal(classifyEmbed(url), null, url);
  }
});

test("iframe code yields only the provider address, never the pasted markup", () => {
  const found = embedFromIframe(
    '<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc&amp;t=3" title="A clip" onload="alert(1)"></iframe><script>alert(1)</script>'
  );
  assert.equal(found.provider, "youtube");
  assert.equal(found.src, "https://www.youtube.com/embed/dQw4w9WgXcQ?si=abc&t=3");
  assert.equal(found.title, "A clip");
  assert.equal(embedFromIframe('<iframe src="https://evil.example/x"></iframe>'), null);
  assert.equal(embedFromIframe('<iframe src="javascript:alert(1)"></iframe>'), null);
  assert.equal(embedFromIframe("<div>no frame</div>"), null);
  assert.equal(embedFromIframe('<iframe src="//player.vimeo.com/video/123"></iframe>').src, "https://player.vimeo.com/video/123");
});
