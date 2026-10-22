import test from "node:test";
import assert from "node:assert/strict";
import { createMaintenanceReader, MAINTENANCE_MESSAGE } from "./maintenance";
import { createMiddleware } from "../middleware";
import { apiFetch } from "./api";
import { useMaintenance } from "./maintenance-client";
import { uploadFileDirect } from "./client-reference-upload";

function request(method, pathname) {
  return { method, url: `https://frontend.example${pathname}`, nextUrl: { pathname }, headers: new Headers(), cookies: { get: () => ({ value: "session" }) } };
}

test("middleware freezes every API write before routing, including unknown methods and dotted paths", async () => {
  const middleware = createMiddleware(async () => ({ enabled: true, available: true }));
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "PROPFIND"]) {
    for (const path of ["/api", "/api/generate/image", "/api/uploads/init", "/api/folders", "/api/history", "/api/file.mov", "/api/maintenance", "/api/auth/login/extra"]) {
      const response = await middleware(request(method, path));
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), { code: "MAINTENANCE", error: MAINTENANCE_MESSAGE });
      assert.equal(response.headers.get("x-middleware-rewrite"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});

test("OFF preserves routing; ON preserves reads, downloads and exact login/logout POSTs only", async () => {
  const prior = { origin: process.env.DJANGO_API_ORIGIN, ingress: process.env.GOAL4_PRIVATE_INGRESS_SECRET };
  process.env.DJANGO_API_ORIGIN = "https://django.example";
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = "disposable-ingress-" + "0".repeat(48);
  try {
    for (const enabled of [true, false]) {
      const middleware = createMiddleware(async () => ({ enabled, available: true }));
      const routes = [["GET", "/api/history"], ["HEAD", "/api/media/original.mov"], ["POST", "/api/auth/login"], ["POST", "/api/auth/logout"]];
      if (!enabled) for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) routes.push([method, "/api/folders"]);
      for (const [method, path] of routes) {
        const response = await middleware(request(method, path));
        assert.equal(response.headers.get("x-middleware-rewrite"), `https://django.example${path}`);
        assert.equal(response.headers.get("x-middleware-request-x-veevee-g4-ingress"), process.env.GOAL4_PRIVATE_INGRESS_SECRET);
      }
      assert.equal((await middleware(request("GET", "/"))).headers.get("x-middleware-next"), "1");
      for (const method of ["GET", "HEAD"]) {
        const status = await middleware(request(method, "/api/maintenance"));
        assert.equal(status.status, 200);
        assert.equal(status.headers.get("cache-control"), "no-store");
        assert.equal(status.headers.get("x-middleware-rewrite"), null);
        if (method === "GET") assert.deepEqual(await status.json(), { enabled, available: true });
        else assert.equal(await status.text(), "");
      }
    }
    const on = createMiddleware(async () => ({ enabled: true, available: true }));
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) for (const path of ["/api/auth/login", "/api/auth/logout"]) {
      assert.equal((await on(request(method, path))).status, 503);
    }
  } finally {
    if (prior.origin === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = prior.origin;
    if (prior.ingress === undefined) delete process.env.GOAL4_PRIVATE_INGRESS_SECRET; else process.env.GOAL4_PRIVATE_INGRESS_SECRET = prior.ingress;
  }
});

test("toggle cache coalesces reads, expires, transitions both ways and fails open without logging secrets", async () => {
  let at = 0, calls = 0, value = true;
  const logs = [];
  const read = createMaintenanceReader(async () => { calls++; if (value instanceof Error) throw value; return value; }, { now: () => at, log: (message) => logs.push(message) });
  assert.deepEqual(await Promise.all([read(), read()]), [{ enabled: true, available: true }, { enabled: true, available: true }]);
  assert.equal(calls, 1);
  value = false;
  at = 4999;
  assert.equal((await read()).enabled, true);
  at = 5000;
  assert.deepEqual(await read(), { enabled: false, available: true });
  value = true; at += 5000;
  assert.equal((await read()).enabled, true);
  value = new Error("secret-connection-token"); at += 5000;
  assert.deepEqual(await read(), { enabled: false, available: false });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /secret-connection-token/);
  value = true; at += 5000;
  assert.equal((await read()).enabled, true, "recovery after source outage");
  for (const invalid of [undefined, null, "true", 1, {}]) {
    const unavailable = createMaintenanceReader(async () => invalid, { log() {} });
    assert.deepEqual(await unavailable(), { enabled: false, available: false });
  }
  const timeout = createMaintenanceReader(() => new Promise(() => {}), { timeout: 5, log() {} });
  assert.deepEqual(await timeout(), { enabled: false, available: false });
});

test("client guards stop writes and direct storage chunks while preserving reads and authentication", async () => {
  const oldFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(url); return new Response("{}"); };
  try {
    useMaintenance.setState({ enabled: true });
    await assert.rejects(apiFetch("/api/folders", { method: "POST" }), { code: "MAINTENANCE" });
    await assert.rejects(uploadFileDirect(new File(["test"], "test.png", { type: "image/png" }), "image-reference"), { code: "MAINTENANCE" });
    assert.deepEqual(seen, []);
    for (const [path, method] of [["/api/history", "GET"], ["/api/auth/login", "POST"], ["/api/auth/logout", "POST"]]) await apiFetch(path, { method });
    assert.equal(seen.length, 3);
    useMaintenance.setState({ enabled: false });
    await apiFetch("/api/folders", { method: "POST" });
    assert.equal(seen.length, 4);
  } finally { useMaintenance.setState({ enabled: false }); globalThis.fetch = oldFetch; }
});

test("an admitted direct upload stops before its next chunk when the tab observes ON", async () => {
  const file = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "video/quicktime" });
  const calls = [];
  try {
    await assert.rejects(uploadFileDirect(file, "video-reference", { fetchImpl: async (url) => {
      calls.push(url);
      if (url === "/api/uploads/init") return new Response(JSON.stringify({ uploadId: "fixture", key: "uploads/video-reference/fixture", uploadUrl: "https://storage.googleapis.com/fixture" }));
      useMaintenance.setState({ enabled: true });
      return new Response(null, { status: 308, headers: { Range: "bytes=0-8388607" } });
    } }), { code: "MAINTENANCE", retryable: false });
    assert.deepEqual(calls, ["/api/uploads/init", "https://storage.googleapis.com/fixture"]);
  } finally { useMaintenance.setState({ enabled: false }); }
});

test("a middleware maintenance refusal does not retry upload negotiation", async () => {
  let calls = 0;
  await assert.rejects(uploadFileDirect(new Blob(["fixture"], { type: "image/png" }), "image-reference", { fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ code: "MAINTENANCE", error: MAINTENANCE_MESSAGE }), { status: 503 });
  } }), { code: "MAINTENANCE", retryable: false });
  assert.equal(calls, 1);
});
