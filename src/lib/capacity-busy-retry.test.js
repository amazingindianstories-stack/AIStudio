import assert from "node:assert/strict";
import test from "node:test";
import { retryWhileBusy, fetchRetryBusy } from "./api.js";
import { apiErrorMessage } from "./api-error.js";
import { uploadFileDirect } from "./client-reference-upload.js";
import { useStore } from "./store";
import { useNotices } from "./notify";

const busy = (retryAfter = "1") => new Response(JSON.stringify({ error: "SLOW_REQUEST_CAPACITY_BUSY" }),
  { status: 429, headers: { "Retry-After": retryAfter, "Content-Type": "application/json" } });
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, random: () => 0.5 };
};

test("busy 429 is retried with Retry-After and jitter until it succeeds", async () => {
  const { now, sleep, random } = clock();
  const waits = [];
  let calls = 0;
  const res = await retryWhileBusy(async () => (++calls < 4 ? busy() : Response.json({ id: "g1" })),
    { now, random, sleep: async (ms) => { waits.push(ms); await sleep(ms); } });
  assert.equal(calls, 4);
  assert.deepEqual(await res.json(), { id: "g1" });
  assert.equal(waits[0], 1000);
  assert.ok(waits[1] > waits[0] && waits[2] > waits[1], "delays grow");
});

test("busy 429 surfaces after the bounded wait and its body stays readable", async () => {
  const { now, sleep, random } = clock();
  let calls = 0;
  const res = await retryWhileBusy(async () => { calls++; return busy(); }, { now, sleep, random, maxWaitMs: 30000 });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: "SLOW_REQUEST_CAPACITY_BUSY" });
  assert.ok(calls > 3 && calls < 20, `bounded attempts, got ${calls}`);
});

test("other 429s and errors are returned immediately", async () => {
  let calls = 0;
  const quota = await retryWhileBusy(async () => { calls++; return new Response(JSON.stringify({ error: "UPLOAD_QUOTA_EXCEEDED" }), { status: 429 }); });
  assert.equal(quota.status, 429);
  const bad = await retryWhileBusy(async () => { calls++; return new Response("<html>", { status: 429 }); });
  assert.equal(bad.status, 429);
  assert.equal(calls, 2);
});

test("busy message is specific and friendly", () => {
  assert.match(apiErrorMessage({ error: "SLOW_REQUEST_CAPACITY_BUSY" }, 429), /busy/i);
});

test("a busy batch submit retries each slot with its own idempotency key and drops nothing", async () => {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  const posts = [];
  let turnedAway = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes("/generate/video")) return Response.json({});
    posts.push(options.headers["Idempotency-Key"]);
    if (turnedAway++ < 2) return busy("0");
    return Response.json({ id: `g${posts.length}`, status: "pending", kind: "video", prompt: "p", createdAt: Date.now() });
  };
  useNotices.setState({ notices: [] });
  useStore.setState({ mode: "video", model: "Seedance 2.5", prompt: "Batch", generating: false, batchCount: 2,
    referenceImages: [], referenceVideos: [], items: [], pendingItems: [] });
  try {
    await useStore.getState().generate();
    assert.equal(posts.length, 4, "two turned away, then both slots accepted");
    assert.equal(posts[0], posts[1], "retry reuses the slot key");
    assert.equal(posts[1], posts[2].replace(/-1$/, "-0"));
    assert.deepEqual(useNotices.getState().notices, []);
  } finally {
    globalThis.fetch = fetchBefore;
    useNotices.setState({ notices: [] });
    useStore.setState(previous, true);
  }
});

test("set-as-first-frame reports a 429/502 JSON body instead of decoding it as an image", async () => {
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "INTERNAL_ERROR" }), { status: 502 });
  try {
    for (const name of ["setAsFirstFrame", "setAsLastFrame"]) {
      const result = await useStore.getState()[name]("/api/media/x");
      assert.equal(result.ok, false);
      assert.match(result.error, /server had a problem/i);
    }
    assert.equal(useStore.getState().firstFrame ?? null, null);
  } finally {
    globalThis.fetch = fetchBefore;
    useStore.setState(previous, true);
  }
});

test("fetchRetryBusy waits out a busy inline media fetch", async () => {
  const fetchBefore = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => (++calls < 2 ? busy("0") : new Response("bytes", { status: 200 }));
  try {
    const res = await fetchRetryBusy("/api/media/x?inline=1", {}, { sleep: async () => {} });
    assert.equal(await res.text(), "bytes");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = fetchBefore;
  }
});

const file = new File([new Uint8Array(1024)], "ref.png", { type: "image/png" });
const upload429 = async (body) => {
  let inits = 0;
  await assert.rejects(uploadFileDirect(file, "image-reference", { retryDelayMs: 0, fetchImpl: async (url) => {
    if (url === "/api/uploads/init") { inits++; return new Response(JSON.stringify(body), { status: 429 }); }
    throw new Error("unexpected " + url);
  } }));
  return inits;
};

test("upload quota 429s are not retried, transient 429s still are", async () => {
  assert.equal(await upload429({ error: "UPLOAD_QUOTA_EXCEEDED" }), 1);
  assert.equal(await upload429({ error: "UPLOAD_INFLIGHT_LIMIT" }), 1);
  assert.equal(await upload429({ error: "SLOW_REQUEST_CAPACITY_BUSY" }), 3);
});
