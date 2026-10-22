import test from "node:test";
import assert from "node:assert/strict";
import { createMaintenanceReader, MAINTENANCE_MESSAGE } from "./maintenance";
import { createMiddleware, maintenanceToggle } from "../middleware";
import { apiFetch } from "./api";
import { useMaintenance } from "./maintenance-client";
import { uploadFileDirect } from "./client-reference-upload";

function request(method, pathname) {
  return { method, url: `https://frontend.example${pathname}`, nextUrl: { pathname }, headers: new Headers(), cookies: { get: () => ({ value: "session" }) } };
}

test("middleware freezes every API write before routing, including unknown methods and dotted paths", async () => {
  const middleware = createMiddleware(async () => ({ enabled: true, available: true }));
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT", "PROPFIND"]) {
    for (const path of ["/api", "/api/generate/image", "/api/uploads/init", "/api/folders", "/api/history", "/api/file.mov", "/api/maintenance", "/api/auth/login/extra", "/api/media-resolve/extra"]) {
      const response = await middleware(request(method, path));
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.deepEqual(await response.json(), { code: "MAINTENANCE", error: MAINTENANCE_MESSAGE });
      assert.equal(response.headers.get("x-middleware-rewrite"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});

test("OFF preserves routing; ON preserves reads, downloads and exact login/logout/media-resolve POSTs only", async () => {
  const prior = { origin: process.env.DJANGO_API_ORIGIN, ingress: process.env.GOAL4_PRIVATE_INGRESS_SECRET };
  process.env.DJANGO_API_ORIGIN = "https://django.example";
  process.env.GOAL4_PRIVATE_INGRESS_SECRET = "disposable-ingress-" + "0".repeat(48);
  try {
    for (const enabled of [true, false]) {
      const middleware = createMiddleware(async () => ({ enabled, available: true }));
      const routes = [["GET", "/api/history"], ["HEAD", "/api/media/original.mov"], ["POST", "/api/auth/login"], ["POST", "/api/auth/logout"], ["POST", "/api/media-resolve"]];
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
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) for (const path of ["/api/auth/login", "/api/auth/logout", "/api/media-resolve"]) {
      assert.equal((await on(request(method, path))).status, 503);
    }
  } finally {
    if (prior.origin === undefined) delete process.env.DJANGO_API_ORIGIN; else process.env.DJANGO_API_ORIGIN = prior.origin;
    if (prior.ingress === undefined) delete process.env.GOAL4_PRIVATE_INGRESS_SECRET; else process.env.GOAL4_PRIVATE_INGRESS_SECRET = prior.ingress;
  }
});

test("toggle cache coalesces reads, expires, transitions both ways and recovers after a source outage", async () => {
  let at = 0, calls = 0, value = true;
  const read = createMaintenanceReader(async () => { calls++; if (value instanceof Error) throw value; return value; }, { now: () => at, log() {} });
  assert.deepEqual(await Promise.all([read(), read()]), [{ enabled: true, available: true }, { enabled: true, available: true }]);
  assert.equal(calls, 1);
  value = false;
  at = 4999;
  assert.equal((await read()).enabled, true);
  at = 5000;
  assert.deepEqual(await read(), { enabled: false, available: true });
  value = true; at += 5000;
  assert.equal((await read()).enabled, true);
  value = new Error("outage"); at += 5000;
  assert.equal((await read()).available, false);
  value = false; at += 5000;
  assert.deepEqual(await read(), { enabled: false, available: true }, "recovery after source outage");
});

const respond = (value) => (typeof value === "function" ? value() : value instanceof Error ? Promise.reject(value) : Promise.resolve(value));

test("a failed read keeps the isolate's last good value and fails open only before any good read, logging without secrets", async () => {
  let at = 0, value = true;
  const logs = [];
  const read = createMaintenanceReader(() => respond(value), { now: () => at, timeout: 5, log: (message) => logs.push(message) });
  assert.deepEqual(await read(), { enabled: true, available: true });
  for (const failure of [new Error("secret-connection-token"), undefined, null, "false", 0, {}, () => new Promise(() => {})]) {
    value = failure; at += 5000;
    assert.deepEqual(await read(), { enabled: true, available: false }, String(failure));
  }
  assert.equal(logs.length, 7);
  for (const message of logs) {
    assert.equal(message, "[maintenance] Toggle unavailable; keeping last known state (ON).");
    assert.doesNotMatch(message, /secret-connection-token/);
  }
  value = false; at += 5000;
  assert.deepEqual(await read(), { enabled: false, available: true });
  value = new Error("outage"); at += 5000;
  assert.deepEqual(await read(), { enabled: false, available: false });
  assert.equal(logs.at(-1), "[maintenance] Toggle unavailable; keeping last known state (OFF).");

  for (const failure of [new Error("secret-connection-token"), undefined, null, "true", 1, {}, () => new Promise(() => {})]) {
    const coldLogs = [];
    const cold = createMaintenanceReader(() => respond(failure), { timeout: 5, log: (message) => coldLogs.push(message) });
    assert.deepEqual(await cold(), { enabled: false, available: false }, String(failure));
    assert.deepEqual(coldLogs, ["[maintenance] Toggle unavailable; failing open (OFF)."]);
  }
});

test("the toggle reads the store connected as GLOBAL_CONFIG or EDGE_CONFIG and fails open when neither is set", async () => {
  const connect = (connections) => (connection) => { connections.push(connection); return { get: async (key) => key === "veevee_maintenance" }; };
  for (const [env, expected] of [
    [{ GLOBAL_CONFIG: "global-connection" }, "global-connection"],
    [{ EDGE_CONFIG: "edge-connection" }, "edge-connection"],
    [{ GLOBAL_CONFIG: "global-connection", EDGE_CONFIG: "edge-connection" }, "global-connection"],
  ]) {
    const connections = [];
    const read = createMaintenanceReader(maintenanceToggle(env, connect(connections)), { log() {} });
    assert.deepEqual(await read(), { enabled: true, available: true }, JSON.stringify(env));
    assert.deepEqual(connections, [expected]);
  }
  const connections = [];
  const unconfigured = createMaintenanceReader(maintenanceToggle({}, connect(connections)), { log() {} });
  assert.deepEqual(await unconfigured(), { enabled: false, available: false });
  assert.deepEqual(connections, []);
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
    for (const [path, method] of [["/api/history", "GET"], ["/api/auth/login", "POST"], ["/api/auth/logout", "POST"], ["/api/media-resolve", "POST"]]) await apiFetch(path, { method });
    assert.equal(seen.length, 4);
    useMaintenance.setState({ enabled: false });
    await apiFetch("/api/folders", { method: "POST" });
    assert.equal(seen.length, 5);
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
