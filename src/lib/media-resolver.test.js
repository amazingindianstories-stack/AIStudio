import assert from "node:assert/strict";
import test from "node:test";
import { __setMediaResolverFetch, cachedDirectUrl, requestDirectUrl } from "./media-resolver.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("concurrent requests share one batched call and are cached until near expiry", async () => {
  const calls = [];
  __setMediaResolverFetch(async (path, options) => {
    const items = JSON.parse(options.body).items;
    calls.push(items);
    return json(200, { items: items.map((item) => ({ ref: item.ref, url: `https://storage.invalid/${item.ref.slice(11)}?w=${item.width}`, expiresAt: Date.now() + 600000 })) });
  });
  const urls = await Promise.all([requestDirectUrl("/api/media/a.png", 512), requestDirectUrl("/api/media/a.png", 512), requestDirectUrl("/api/media/b.mov")]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.deepEqual(urls, ["https://storage.invalid/a.png?w=512", "https://storage.invalid/a.png?w=512", "https://storage.invalid/b.mov?w=null"]);
  assert.ok(cachedDirectUrl("/api/media/a.png", 512));
  await requestDirectUrl("/api/media/a.png", 512);
  assert.equal(calls.length, 1);
});

test("unresolvable references, denials and backend failures fall back to /api/media", async () => {
  let calls = 0;
  __setMediaResolverFetch(async () => { calls += 1; return json(200, { items: [{ ref: "/api/media/x", url: null }] }); });
  assert.equal(await requestDirectUrl("/api/media/x"), null);
  assert.equal(await requestDirectUrl("https://elsewhere.example/a.png"), null);
  assert.equal(calls, 1);
  __setMediaResolverFetch(async () => { calls += 1; return json(404, {}); });
  assert.equal(await requestDirectUrl("/api/media/y"), null);
  assert.equal(await requestDirectUrl("/api/media/z"), null); // disabled after a failure: no second request
  assert.equal(calls, 2);
});

test("large backlogs are split into batches of at most 100", async () => {
  const sizes = [];
  __setMediaResolverFetch(async (path, options) => {
    const items = JSON.parse(options.body).items;
    sizes.push(items.length);
    return json(200, { items: items.map((item) => ({ ref: item.ref, url: "u", expiresAt: Date.now() + 600000 })) });
  });
  await Promise.all(Array.from({ length: 250 }, (_, i) => requestDirectUrl(`/api/media/${i}.png`, 512)));
  assert.deepEqual(sizes, [100, 100, 50]);
});
