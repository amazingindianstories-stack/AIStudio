// Flows: a Flow step is a sticky carrying `flow` settings (an AI instruction block). Arrows pointing at it bring
// its inputs, its own text is the output, and arrows leaving it feed the next step. Everything here is pure; the
// run itself (quotes, jobs, writing outputs) is in src/lib/flow-run.js.
export const MAX_FLOW_STEPS = 12;
export const MAX_INPUTS = 12;
export const MAX_INPUT_CHARS = 20000;

/** The text an object contributes as a Flow input. */
export function nodeText(node) {
  if (!node) return "";
  if (node.type === "frame") return String(node.name ?? "");
  return typeof node.text === "string" ? node.text : "";
}

export function isFlowStep(node) {
  return node?.type === "sticky" && !!node.flow && typeof node.flow.task === "string" && node.flow.task.trim() !== "";
}

export function flowSteps(state) {
  return state.nodes.filter(isFlowStep);
}

/** Ids of the objects with an arrow into `stepId`, in connector order, without repeats. */
export function inputIds(state, stepId) {
  const seen = new Set();
  for (const c of state.connectors ?? []) {
    if (c.to?.nodeId === stepId && c.from?.nodeId && c.from.nodeId !== stepId) seen.add(c.from.nodeId);
  }
  return [...seen];
}

/** Steps in the order they must run (inputs first). Steps in a cycle are left out and reported in `cyclic`. */
export function runOrder(state, stepIds) {
  const steps = new Set(stepIds);
  const upstream = new Map([...steps].map((id) => [id, inputIds(state, id).filter((from) => steps.has(from))]));
  const order = [];
  const done = new Set();
  let progress = true;
  while (progress && done.size < steps.size) {
    progress = false;
    for (const id of steps) {
      if (done.has(id) || !upstream.get(id).every((from) => done.has(from))) continue;
      done.add(id);
      order.push(id);
      progress = true;
    }
  }
  return { order, cyclic: [...steps].filter((id) => !done.has(id)) };
}

/** Steps that read the output of `stepId` directly or through other steps. */
export function downstreamOf(state, stepId) {
  const out = [];
  const queue = [stepId];
  const seen = new Set(queue);
  while (queue.length) {
    const from = queue.shift();
    for (const c of state.connectors ?? []) {
      if (c.from?.nodeId !== from || seen.has(c.to?.nodeId)) continue;
      seen.add(c.to.nodeId);
      queue.push(c.to.nodeId);
      const node = state.nodes.find((n) => n.id === c.to.nodeId);
      if (isFlowStep(node)) out.push(node.id);
    }
  }
  return out;
}

/** The inputs of a step as the server takes them: `[{ text }]`, limited in count and length. */
export function stepInputs(state, stepId, outputs = {}) {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  return inputIds(state, stepId)
    .slice(0, MAX_INPUTS)
    .map((id) => ({ text: (id in outputs ? outputs[id] : nodeText(byId.get(id))).slice(0, MAX_INPUT_CHARS) }))
    .filter((item) => item.text.trim() !== "");
}

/** A short stable fingerprint of what a step would send: an unchanged step is not run (or paid for) again. */
export function inputHash(task, inputs) {
  const text = JSON.stringify([task, inputs.map((i) => i.text)]);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b + code, 2246822519) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The request body for one step. */
export function stepBody(step, inputs, processing = "basic") {
  return { task: step.flow.task, processing, inputs };
}

/**
 * The plan of a run over `stepIds`: each step in order with its request body and hash, and whether it is current
 * (its hash matches the last run and no upstream step will change). `outputs` maps step ids to the output a
 * previous step of this run just produced, so planning can be redone as results arrive.
 */
export function planRun(state, stepIds, { force = false, processing = "basic", outputs = {} } = {}) {
  const { order, cyclic } = runOrder(state, stepIds);
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const stale = new Set();
  const steps = order.map((id) => {
    const step = byId.get(id);
    const inputs = stepInputs(state, id, outputs);
    const hash = inputHash(step.flow.task, inputs);
    const upstreamStale = inputIds(state, id).some((from) => stale.has(from));
    const skip = !force && !upstreamStale && step.flow.inputHash === hash && nodeText(step) !== "";
    if (!skip) stale.add(id);
    return { id, body: stepBody(step, inputs, processing), hash, skip };
  });
  return { steps, cyclic };
}

/** One new Flow step as an unplaced sticky (the caller positions it). */
export function newStep({ task, block = "instruction", id = crypto.randomUUID(), x = 0, y = 0 }) {
  return {
    id, type: "sticky", x, y, w: 240, h: 200, text: "", fill: "#6f9bd1", fontSize: 16, color: "#1c1a12", opacity: 1,
    parentId: null, groupId: null, aiCreated: true,
    flow: { block, task },
  };
}

/** A starter from the server's template list (`{ steps: [{ task }] }`, run in order) as nodes and arrows. */
export function templateGraph(template, origin) {
  const nodes = template.steps.map((s, i) => newStep({ task: s.task, x: origin.x + i * 300, y: origin.y }));
  const connectors = nodes.slice(1).map((node, i) => ({
    id: crypto.randomUUID(), from: { nodeId: nodes[i].id, anchor: "auto" }, to: { nodeId: node.id, anchor: "auto" }, kind: "arrow", stroke: "#000000", strokeWidth: 2,
  }));
  return { nodes, connectors };
}
