import assert from "node:assert/strict";
import test from "node:test";
import { useBoardAi, requestFingerprint } from "./board-ai.js";
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

test("a result for another board is never placed on the open one", async (t) => {
  loadedBoard();
  const calls = server(t, () => json(200, { jobs: [] }));
  await useBoardAi.getState().attach(BOARD);
  await useBoardAi.getState().settle(job({ boardId: "77777777-7777-4777-8777-777777777777", status: "succeeded", result: NOTES }));
  assert.equal(useCanvasStore.getState().history.present.nodes.length, 0);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
});
