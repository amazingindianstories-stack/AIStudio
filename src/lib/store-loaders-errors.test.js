import test from "node:test";
import assert from "node:assert/strict";
import { useStore } from "./store.js";

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("loadMe keeps currentUser and does not redirect on 502 JSON error", async () => {
  const prevFetch = globalThis.fetch;
  const prevWindow = globalThis.window;
  const location = { href: "http://localhost/", pathname: "/" };
  globalThis.window = { location };
  useStore.setState({ currentUser: { id: "u1", email: "a@b.com" } });
  globalThis.fetch = async () =>
    jsonResponse({ error: "x", code: "UPSTREAM_TIMEOUT" }, 502);

  try {
    await useStore.getState().loadMe();
    assert.equal(location.href, "http://localhost/");
    assert.deepEqual(useStore.getState().currentUser, { id: "u1", email: "a@b.com" });
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.window = prevWindow;
  }
});

test("loadMe still redirects on 200 { user: null }", async () => {
  const prevFetch = globalThis.fetch;
  const prevWindow = globalThis.window;
  const location = { href: "http://localhost/", pathname: "/", search: "?board=abc" };
  globalThis.window = { location };
  globalThis.fetch = async () => jsonResponse({ user: null }, 200);

  try {
    await useStore.getState().loadMe();
    assert.equal(location.href, "/login?next=%2F%3Fboard%3Dabc");
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.window = prevWindow;
  }
});

test("loadProjects retains projects and activeProjectId on 503 JSON error", async () => {
  const prevFetch = globalThis.fetch;
  useStore.setState({ projects: [{ id: "p1" }], activeProjectId: "p1" });
  globalThis.fetch = async () => jsonResponse({ error: "BACKEND_ROUTING_UNAVAILABLE" }, 503);

  try {
    await useStore.getState().loadProjects();
    assert.deepEqual(useStore.getState().projects, [{ id: "p1" }]);
    assert.equal(useStore.getState().activeProjectId, "p1");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("loadCounts, loadThread, and loadLimits retain prior state on 500 JSON error", async () => {
  const prevFetch = globalThis.fetch;
  const priorCounts = {
    project: { all: 5, images: 3, videos: 2 },
    globalLibrary: { all: 1, images: 1, videos: 0 },
    allAssets: 6,
    favorites: 2,
  };
  const priorThread = [{ id: "item-1", prompt: "hello", projectId: "p1", folderId: null, kind: "image" }];
  const priorLimits = { maxPromptLength: 500 };

  useStore.setState({
    counts: priorCounts,
    limits: priorLimits,
  });
  globalThis.fetch = async () => jsonResponse({ items: priorThread }, 200);
  await useStore.getState().loadThread();

  globalThis.fetch = async () => jsonResponse({ error: "x" }, 500);

  try {
    await useStore.getState().loadCounts();
    await useStore.getState().loadThread();
    await useStore.getState().loadLimits();
    assert.deepEqual(useStore.getState().counts, priorCounts);
    assert.deepEqual(useStore.getState().threadItems, priorThread);
    assert.deepEqual(useStore.getState().limits, priorLimits);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
