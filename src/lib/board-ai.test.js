import assert from "node:assert/strict";
import test from "node:test";
import { useBoardAi, requestFingerprint, trackPanelLayout } from "./board-ai.js";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState } from "./canvas/serialization.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const BOARD = "11111111-1111-4111-8111-111111111111";
const NOTES = { notes: [{ text: "One", color: "yellow" }, { text: "Two", color: "pink" }] };

function job(fields = {}) {
  return { id: "22222222-2222-4222-8222-222222222222", boardId: BOARD, format: "stickies", prompt: "ideas", parentJobId: null,
    generationId: "g1", placedNodeIds: null, placedAt: null, createdAt: 1, status: "queued", costCents: 3, ...fields };
}

function loadedBoard(nodes = []) {
  useCanvasStore.setState({ boardId: BOARD, loaded: true, selection: [], selectedConnectorIds: [],
    history: { past: [], present: { ...emptyCanvasState(), nodes }, future: [] } });
}

function server(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const call = { url, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return handler(call);
  });
  return calls;
}

test.afterEach(() => {
  useBoardAi.getState().detach();
  useCanvasStore.getState().reset();
});

test("a submission sends one Idempotency-Key, reuses it after a dropped answer and starts fresh after a refusal", async (t) => {
  loadedBoard();
  let mode = "drop";
  const calls = server(t, (call) => {
    if (call.method === "POST" && call.url.endsWith("/ai-jobs")) {
      if (mode === "drop") throw new TypeError("Failed to fetch");
      if (mode === "refuse") return json(409, { error: "Paid Preview budget unavailable or exhausted; no provider submission occurred.", code: "PREVIEW_PAID_BUDGET_HOLD" });
      return json(201, { job: job() });
    }
    return json(200, { jobs: [] });
  });
  await useBoardAi.getState().attach(BOARD);
  const request = { format: "stickies", prompt: "ideas" };
  assert.equal(await useBoardAi.getState().submit(request), null);
  assert.equal(useBoardAi.getState().error, "Failed to fetch");
  mode = "ok";
  const created = await useBoardAi.getState().submit(request);
  assert.equal(created.id, job().id);
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  assert.ok(posts[0].headers["Idempotency-Key"]);
  assert.equal(posts[1].headers["Idempotency-Key"], posts[0].headers["Idempotency-Key"], "a retry of the same request reuses its key");
  assert.deepEqual(posts[1].body, request);

  mode = "refuse";
  useBoardAi.setState({ job: null });
  assert.equal(await useBoardAi.getState().submit({ format: "stickies", prompt: "more" }), null);
  assert.match(useBoardAi.getState().error, /budget/);
  mode = "ok";
  await useBoardAi.getState().submit({ format: "stickies", prompt: "more" });
  const [refused, fresh] = calls.filter((call) => call.method === "POST").slice(2);
  assert.notEqual(fresh.headers["Idempotency-Key"], refused.headers["Idempotency-Key"], "a refused request does not pin its key");
  assert.notEqual(requestFingerprint(BOARD, request), requestFingerprint(BOARD, { ...request, prompt: "other" }));
});

test("a finished job is claimed, then placed as one undo step at the viewport centre", async (t) => {
  loadedBoard([{ id: "existing", type: "sticky", x: 0, y: 0, w: 10, h: 10, text: "", fill: "#fff", fontSize: 16, color: "#000", parentId: null, groupId: null }]);
  const calls = server(t, (call) => {
    if (call.method === "PATCH") return json(200, { job: job({ status: "succeeded", result: NOTES, placedNodeIds: call.body.placedNodeIds, placedAt: 5 }) });
    return json(200, { jobs: [] });
  });
  await useBoardAi.getState().attach(BOARD);
  const pastBefore = useCanvasStore.getState().history.past.length;
  await useBoardAi.getState().settle(job({ status: "succeeded", result: NOTES }));
  const canvas = useCanvasStore.getState();
  const added = canvas.history.present.nodes.filter((node) => node.id !== "existing");
  assert.deepEqual(added.map((node) => node.text), ["One", "Two"]);
  assert.equal(canvas.history.past.length, pastBefore + 1, "one undo step");
  assert.deepEqual(canvas.selection, added.map((node) => node.id));
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body.placedNodeIds, added.map((node) => node.id));
  assert.deepEqual(useBoardAi.getState().placed.nodeIds, added.map((node) => node.id));

  // Another tab placed it first: nothing is inserted here.
  t.mock.reset();
  server(t, () => json(409, { error: "This result was already placed.", code: "ALREADY_PLACED" }));
  await useBoardAi.getState().settle(job({ id: "33333333-3333-4333-8333-333333333333", status: "succeeded", result: NOTES }));
  assert.equal(useCanvasStore.getState().history.present.nodes.length, 3);
});

test("a refinement replaces the nodes of the result it refines, in place, and undo restores them", async (t) => {
  loadedBoard();
  server(t, (call) => (call.method === "PATCH"
    ? json(200, { job: { placedAt: 5, placedNodeIds: call.body.placedNodeIds } })
    : json(200, { jobs: [] })));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().settle(job({ status: "succeeded", result: NOTES }));
  const first = useBoardAi.getState().placed;
  // The artist moves the first result before refining it.
  useCanvasStore.setState((state) => ({ history: { ...state.history, present: { ...state.history.present,
    nodes: state.history.present.nodes.map((node) => ({ ...node, x: node.x + 5000 })) } } }));
  const movedCenter = (() => {
    const nodes = useCanvasStore.getState().history.present.nodes;
    return (Math.min(...nodes.map((n) => n.x)) + Math.max(...nodes.map((n) => n.x + n.w))) / 2;
  })();
  await useBoardAi.getState().settle(job({ id: "44444444-4444-4444-8444-444444444444", parentJobId: first.jobId, status: "succeeded",
    result: { notes: [{ text: "Shorter", color: "green" }] } }));
  const nodes = useCanvasStore.getState().history.present.nodes;
  assert.deepEqual(nodes.map((node) => node.text), ["Shorter"]);
  assert.equal(nodes[0].x + nodes[0].w / 2, movedCenter);
  useCanvasStore.getState().undo();
  assert.deepEqual(useCanvasStore.getState().history.present.nodes.map((node) => node.text), ["One", "Two"]);
});

test("resuming a board keeps polling unfinished jobs and dismisses failed ones", async (t) => {
  loadedBoard();
  const calls = server(t, (call) => {
    if (call.method === "PATCH") return json(200, { job: {} });
    return json(200, { jobs: [job({ id: "55555555-5555-4555-8555-555555555555", status: "running" }),
      job({ id: "66666666-6666-4666-8666-666666666666", status: "failed", error: "The AI provider returned an error, so this AI result stopped." })] });
  });
  await useBoardAi.getState().attach(BOARD);
  assert.equal(useBoardAi.getState().job.id, "55555555-5555-4555-8555-555555555555");
  const dismissed = calls.find((call) => call.method === "PATCH");
  assert.ok(dismissed.url.endsWith("/66666666-6666-4666-8666-666666666666"));
  assert.deepEqual(dismissed.body, { placedNodeIds: [] });
});

test("every unfinished job is polled, so an older one is placed when it ends while the panel follows the newest", async (t) => {
  loadedBoard();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const OLDER = "55555555-5555-4555-8555-555555555555";
  const NEWER = "66666666-6666-4666-8666-666666666666";
  const calls = server(t, (call) => {
    if (call.method === "PATCH") return json(200, { job: job({ id: OLDER, status: "succeeded", result: NOTES, placedNodeIds: call.body.placedNodeIds, placedAt: 5 }) });
    if (call.url.includes(`ids=${OLDER}`)) return json(200, { jobs: [job({ id: OLDER, status: "succeeded", result: NOTES })] });
    if (call.url.includes(`ids=${NEWER}`)) return json(200, { jobs: [job({ id: NEWER, createdAt: 2, status: "running" })] });
    return json(200, { jobs: [job({ id: NEWER, createdAt: 2, status: "running" }), job({ id: OLDER, createdAt: 1, status: "running" })] });
  });
  await useBoardAi.getState().attach(BOARD);
  assert.equal(useBoardAi.getState().job.id, NEWER);
  t.mock.timers.tick(1500);
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const polled = calls.filter((call) => call.method === "GET" && call.url.includes("ids="));
  assert.deepEqual(polled.map((call) => call.url.split("ids=")[1]).sort(), [OLDER, NEWER]);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.ok(patch?.url.endsWith(`/${OLDER}`), "the older job's result is claimed");
  assert.deepEqual(useCanvasStore.getState().history.present.nodes.map((node) => node.text), ["One", "Two"]);
  assert.equal(useBoardAi.getState().job.id, NEWER, "the panel keeps following the newest job");
  assert.equal(useBoardAi.getState().job.status, "running");
});

test("a job settling in the background never takes over the panel's job, last result or error", async (t) => {
  loadedBoard();
  server(t, (call) => (call.method === "PATCH"
    ? json(200, { job: { placedAt: 5, placedNodeIds: call.body.placedNodeIds } })
    : json(200, { jobs: [] })));
  await useBoardAi.getState().attach(BOARD);
  const NEWER = "44444444-4444-4444-8444-444444444444";
  const REFINING = "55555555-5555-4555-8555-555555555555";
  await useBoardAi.getState().settle(job({ id: NEWER, createdAt: 2, status: "succeeded", result: NOTES }));
  await useBoardAi.getState().settle(job({ id: REFINING, createdAt: 3, parentJobId: NEWER, status: "running" }));
  // An older job, started elsewhere, finishes while the refinement runs; another older one fails.
  await useBoardAi.getState().settle(job({ createdAt: 1, status: "succeeded", result: { notes: [{ text: "Older", color: "blue" }] } }));
  await useBoardAi.getState().settle(job({ id: "66666666-6666-4666-8666-666666666666", createdAt: 1, status: "failed", error: "Stopped." }));
  assert.equal(useBoardAi.getState().job.id, REFINING);
  assert.equal(useBoardAi.getState().placed.jobId, NEWER);
  assert.equal(useBoardAi.getState().error, null);
  await useBoardAi.getState().settle(job({ id: REFINING, createdAt: 3, parentJobId: NEWER, status: "succeeded",
    result: { notes: [{ text: "Refined", color: "green" }] } }));
  assert.deepEqual(useCanvasStore.getState().history.present.nodes.map((node) => node.text).sort(), ["Older", "Refined"],
    "the older result is on the board and the refinement replaced the result it refines");
});

test("after Start over, an older job settling in the background leaves the fresh prompt alone", async (t) => {
  loadedBoard();
  server(t, (call) => (call.method === "PATCH"
    ? json(200, { job: { placedAt: 5, placedNodeIds: call.body.placedNodeIds } })
    : json(200, { jobs: [] })));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().settle(job({ id: "44444444-4444-4444-8444-444444444444", createdAt: 2, status: "succeeded", result: NOTES }));
  useBoardAi.getState().startOver();
  await useBoardAi.getState().settle(job({ createdAt: 1, status: "succeeded", result: { notes: [{ text: "Older", color: "blue" }] } }));
  await useBoardAi.getState().settle(job({ id: "66666666-6666-4666-8666-666666666666", createdAt: 1, status: "failed", error: "Stopped." }));
  const { job: followed, placed, error } = useBoardAi.getState();
  assert.deepEqual({ followed, placed, error }, { followed: null, placed: null, error: null }, "nothing to refine and no stale error");
  assert.ok(useCanvasStore.getState().history.present.nodes.some((node) => node.text === "Older"), "the older result is still placed");
});

test("results finishing together are placed one after another in free space, never on top of each other", async (t) => {
  loadedBoard();
  server(t, (call) => (call.method === "PATCH"
    ? json(200, { job: { placedAt: 5, placedNodeIds: call.body.placedNodeIds } })
    : json(200, { jobs: [] })));
  await useBoardAi.getState().attach(BOARD);
  const first = job({ status: "succeeded", result: NOTES });
  const second = job({ id: "44444444-4444-4444-8444-444444444444", status: "succeeded", result: NOTES });
  await Promise.all([useBoardAi.getState().settle(first), useBoardAi.getState().settle(second),
    useBoardAi.getState().placeAgain({ ...first, placedAt: 5 })]);
  const nodes = useCanvasStore.getState().history.present.nodes;
  assert.equal(nodes.length, 6);
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!nodes.some((a, i) => nodes.some((b, j) => i !== j && overlaps(a, b))), "no two placed notes overlap");
});

test("a result for another board is never placed on the open one", async (t) => {
  loadedBoard();
  const calls = server(t, () => json(200, { jobs: [] }));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().settle(job({ boardId: "77777777-7777-4777-8777-777777777777", status: "succeeded", result: NOTES }));
  assert.equal(useCanvasStore.getState().history.present.nodes.length, 0);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
});

test("a board switch while the claim is in flight leaves the result listed, to be placed again", async (t) => {
  loadedBoard();
  let release;
  const calls = server(t, (call) => {
    if (call.method === "PATCH") {
      return new Promise((resolve) => {
        release = () => resolve(json(200, { job: job({ status: "succeeded", result: NOTES, placedNodeIds: call.body.placedNodeIds, placedAt: 5 }) }));
      });
    }
    return json(200, { jobs: [] });
  });
  await useBoardAi.getState().attach(BOARD);
  const placing = useBoardAi.getState().settle(job({ status: "succeeded", result: NOTES }));
  await new Promise((resolve) => setImmediate(resolve));
  useCanvasStore.setState({ boardId: "88888888-8888-4888-8888-888888888888" });
  await useBoardAi.getState().attach("88888888-8888-4888-8888-888888888888");
  release();
  await placing;
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(useCanvasStore.getState().history.present.nodes.length, 0, "claimed, but the board had changed");

  // Back on the board, the claimed result is listed and placed again without a new job or a second claim.
  loadedBoard();
  await useBoardAi.getState().attach(BOARD);
  t.mock.reset();
  const later = server(t, (call) => json(200, { jobs: call.url.endsWith("?recent=1")
    ? [job({ status: "succeeded", result: NOTES, placedNodeIds: ["gone-1", "gone-2"], placedAt: 5 })] : [] }));
  await useBoardAi.getState().loadRecent();
  const [recent] = useBoardAi.getState().recent;
  assert.equal(recent.placedAt, 5);
  await useBoardAi.getState().placeAgain(recent);
  assert.deepEqual(useCanvasStore.getState().history.present.nodes.map((node) => node.text), ["One", "Two"]);
  assert.deepEqual(later.map((call) => call.method), ["GET"], "placing again never submits, bills or claims");
});

test("placing a result again adds a fresh copy in free space as one undo step, and it can be refined", async (t) => {
  loadedBoard();
  server(t, (call) => (call.method === "PATCH"
    ? json(200, { job: job({ status: "succeeded", result: NOTES, placedNodeIds: call.body.placedNodeIds, placedAt: 5 }) })
    : json(200, { jobs: [] })));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().settle(job({ status: "succeeded", result: NOTES }));
  const first = useCanvasStore.getState().history.present.nodes;
  const pastBefore = useCanvasStore.getState().history.past.length;
  await useBoardAi.getState().placeAgain(job({ status: "succeeded", result: NOTES, placedAt: 5 }));
  const canvas = useCanvasStore.getState();
  const copies = canvas.history.present.nodes.filter((node) => !first.some((old) => old.id === node.id));
  assert.deepEqual(copies.map((node) => node.text), ["One", "Two"]);
  assert.equal(canvas.history.past.length, pastBefore + 1, "one undo step");
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!copies.some((copy) => first.some((old) => overlaps(copy, old))), "in free space, not on the first copy");
  assert.deepEqual(useBoardAi.getState().placed.nodeIds, copies.map((node) => node.id));
  canvas.undo();
  assert.equal(useCanvasStore.getState().history.present.nodes.length, first.length);
});

// The open panel floats over the bottom centre of a 1600 x 900 canvas, in canvas pixels; nothing else covers it.
const PANEL = { x: 520, y: 588, w: 560, h: 240 };
const LAYOUT = { panel: PANEL, visible: { x: 0, y: 0, w: 1600, h: 900 } };
const sticky = (id, x, y, w, h) => ({ id, type: "sticky", x, y, w, h, text: "", fill: "#fff", fontSize: 16, color: "#000", parentId: null, groupId: null });
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function onScreen(nodes, vp) {
  const x0 = Math.min(...nodes.map((n) => n.x));
  const y0 = Math.min(...nodes.map((n) => n.y));
  const x1 = Math.max(...nodes.map((n) => n.x + n.w));
  const y1 = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: (x0 - vp.x) * vp.zoom, y: (y0 - vp.y) * vp.zoom, w: (x1 - x0) * vp.zoom, h: (y1 - y0) * vp.zoom };
}

test("a new result avoids the board area under the open panel", async (t) => {
  useCanvasStore.getState().setViewportSize(1600, 900);
  t.after(trackPanelLayout(() => LAYOUT));
  // The viewport centre and the slot above it are taken; the slot below is under the panel, so the result goes beside.
  loadedBoard([sticky("tall", 588, 0, 424, 560)]);
  server(t, (call) => (call.method === "PATCH"
    ? json(200, { job: job({ status: "succeeded", result: NOTES, placedNodeIds: call.body.placedNodeIds, placedAt: 5 }) })
    : json(200, { jobs: [] })));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().settle(job({ status: "succeeded", result: NOTES }));
  const { nodes, viewport } = useCanvasStore.getState().history.present;
  const added = nodes.filter((node) => node.id !== "tall");
  assert.deepEqual(added.map((node) => node.text), ["One", "Two"]);
  const shown = onScreen(added, viewport);
  assert.ok(!intersects(shown, PANEL), `the result is not under the panel: ${JSON.stringify(shown)}`);
  assert.ok(shown.x >= 0 && shown.y >= 0 && shown.x + shown.w <= 1600 && shown.y + shown.h <= 900, "fully on screen");
  assert.deepEqual(viewport, { x: 0, y: 0, zoom: 1 }, "no pan needed");
});

test("a result placed again where it would be hidden pans the board into view, without a new job or undo step", async (t) => {
  useCanvasStore.getState().setViewportSize(1600, 900);
  t.after(trackPanelLayout(() => LAYOUT));
  // Content fills the whole visible canvas, so the nearest free slot is off screen, above it.
  const wall = { x: -100, y: -100, w: 1800, h: 1100 };
  loadedBoard([sticky("wall", wall.x, wall.y, wall.w, wall.h)]);
  const calls = server(t, () => json(200, { jobs: [] }));
  await useBoardAi.getState().attach(BOARD);
  const pastBefore = useCanvasStore.getState().history.past.length;
  await useBoardAi.getState().placeAgain(job({ status: "succeeded", result: NOTES, placedAt: 5 }));
  const canvas = useCanvasStore.getState();
  const added = canvas.history.present.nodes.filter((node) => node.id !== "wall");
  assert.equal(added.length, 2);
  assert.ok(!added.some((node) => intersects(node, wall)), "in free space");
  const { viewport } = canvas.history.present;
  assert.equal(viewport.zoom, 1, "panned, not zoomed");
  assert.ok(viewport.y < 0, "the board pans up to the result");
  const shown = onScreen(added, viewport);
  assert.ok(shown.x >= 0 && shown.y >= 0 && shown.x + shown.w <= 1600 && shown.y + shown.h <= 900, `fully on screen: ${JSON.stringify(shown)}`);
  assert.ok(!intersects(shown, PANEL), "clear of the panel");
  assert.equal(canvas.history.past.length, pastBefore + 1, "the placement is one undo step; the pan adds none");
  assert.deepEqual(calls.map((call) => call.method), ["GET"], "placing again never submits, bills or claims");
});

test("a result never lands under the asset panel either, and is panned out from under it", async (t) => {
  useCanvasStore.getState().setViewportSize(1600, 900);
  // The asset panel covers the canvas's left 300 px.
  const visible = { x: 300, y: 0, w: 1300, h: 900 };
  t.after(trackPanelLayout(() => ({ panel: PANEL, visible })));
  // The centre, the slots above and below it, and the right are taken; the left slot is under the asset panel.
  loadedBoard([sticky("block", 300, -400, 2000, 1400)]);
  server(t, () => json(200, { jobs: [] }));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().placeAgain(job({ status: "succeeded", result: NOTES, placedAt: 5 }));
  const { nodes, viewport } = useCanvasStore.getState().history.present;
  const added = nodes.filter((node) => node.id !== "block");
  assert.equal(added.length, 2);
  const shown = onScreen(added, viewport);
  assert.ok(shown.x >= 300 && shown.y >= 0 && shown.x + shown.w <= 1600 && shown.y + shown.h <= 900, `beside the asset panel: ${JSON.stringify(shown)}`);
  assert.ok(!intersects(shown, PANEL), "clear of the AI panel");
});
