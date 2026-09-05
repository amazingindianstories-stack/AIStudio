import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifySeedValidation,
  expectedKlingMatrixPass,
  expectedKlingResolutionPass,
  expectedKlingRoutingPass,
  failedKlingResolutionCases,
  failedKlingRoutingCases,
  formatKlingCaseLabels,
  runKlingValidation,
  summarizeKlingMatrix,
} from "./kling-validation";

const reply = (message, code = 1201, status = 400) => new Response(
  JSON.stringify({ code, message }), { status, headers: { "content-type": "application/json" } }
);

test("seed validation is conservative on identical and mixed errors", () => {
  const r = (message) => ({ json: { message } });
  assert.equal(classifySeedValidation(r("invalid n"), r("invalid n"), r("invalid n")), "inconclusive");
  assert.equal(classifySeedValidation(r("invalid n"), r("invalid n"), r("seed must be integer")), "supported");
});

test("expected Kling matrix pins the 1K/2K text/reference contract", () => {
  const matrix = {};
  for (const model of ["kling-v3", "kling-v2-1"]) for (const resolution of ["1k", "2k"])
    for (const mode of ["t2i", "i2i"]) matrix[`${model}:${resolution}:${mode}`] = {
      resolutionRejected: model === "kling-v2-1" && resolution === "2k" && mode === "i2i",
      modelRejected: false,
      validationReachedN: !(model === "kling-v2-1" && resolution === "2k" && mode === "i2i"),
      rejectedWithoutTask: true,
    };
  assert.equal(expectedKlingMatrixPass(matrix), true);
  assert.equal(expectedKlingResolutionPass(matrix), true);
  assert.equal(expectedKlingRoutingPass(matrix), true);
  assert.deepEqual(summarizeKlingMatrix(matrix), {
    routingPassed: 2, routingTotal: 2, resolutionPassed: 8, resolutionTotal: 8,
  });
  matrix["kling-v3:2k:i2i"].resolutionRejected = true;
  assert.equal(expectedKlingMatrixPass(matrix), false);
  assert.deepEqual(failedKlingRoutingCases(matrix), []);
  assert.deepEqual(failedKlingResolutionCases(matrix), ["kling-v3:2k:i2i"]);
  assert.equal(formatKlingCaseLabels(failedKlingResolutionCases(matrix)), "kling-v3[2k:i2i]");
  assert.deepEqual(summarizeKlingMatrix(matrix), {
    routingPassed: 2, routingTotal: 2, resolutionPassed: 7, resolutionTotal: 8,
  });
});

test("live validator uses only reads and deliberately invalid no-task writes", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init });
    if (!init.method) {
      return new Response(JSON.stringify({ code: 0, data: { tasks: [] } }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    assert.equal(body.n, 99);
    if (body.seed === "not-a-number") return reply("seed must be integer");
    if (body.model_name === "kling-v2-1" && body.resolution === "2k" && body.image) {
      return reply("resolution is not supported");
    }
    return reply("n must be between 1 and 9");
  };
  const output = await runKlingValidation({ apiKey: "test", fetchImpl });
  assert.equal(output.authenticated, true);
  assert.equal(output.requestSafetyPass, true);
  assert.equal(output.taskListStable, true);
  assert.equal(output.noTaskCreated, true);
  assert.equal(output.seedVerdict, "supported");
  assert.equal(expectedKlingMatrixPass(output.matrix), true);
  assert.equal(seen.filter((call) => call.init.method === "POST").length, 11);
  assert.equal(seen.filter((call) => !call.init.method).length, 2);
});

test("task-list changes fail the no-task invariant without exposing identifiers", async () => {
  let reads = 0;
  const fetchImpl = async (_url, init = {}) => {
    if (!init.method) {
      reads++;
      return new Response(JSON.stringify({
        code: 0,
        data: { tasks: [{ task_id: reads === 1 ? "before-private" : "after-private" }] },
      }), { status: 200 });
    }
    return reply("n must be between 1 and 9");
  };
  const output = await runKlingValidation({ apiKey: "test", fetchImpl });
  assert.equal(output.requestSafetyPass, true);
  assert.equal(output.taskListStable, false);
  assert.equal(output.noTaskCreated, false);
  assert.equal(JSON.stringify(output).includes("before-private"), false);
  assert.equal(JSON.stringify(output).includes("after-private"), false);
});

test("an accepted or malformed write fails request safety", async () => {
  let writes = 0;
  const fetchImpl = async (_url, init = {}) => {
    if (!init.method) {
      return new Response(JSON.stringify({ code: 0, data: { tasks: [] } }), { status: 200 });
    }
    writes++;
    if (writes === 1) {
      return new Response(JSON.stringify({ code: 0, data: { task_id: "private-task" } }), { status: 200 });
    }
    return reply("n must be between 1 and 9");
  };
  const output = await runKlingValidation({ apiKey: "test", fetchImpl });
  assert.equal(output.requestSafetyPass, false);
  assert.equal(output.noTaskCreated, false);
  assert.equal(JSON.stringify(output).includes("private-task"), false);
});

test("a malformed task-list response fails closed", async () => {
  const fetchImpl = async (_url, init = {}) => init.method
    ? reply("n must be between 1 and 9")
    : reply("ok", 0, 200);
  const output = await runKlingValidation({ apiKey: "test", fetchImpl });
  assert.equal(output.requestSafetyPass, true);
  assert.equal(output.taskListStable, false);
  assert.equal(output.noTaskCreated, false);
});
