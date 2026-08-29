import sharp from "sharp";
import { KLING_MODELS } from "./providers/kling";

export const KLING_VALIDATION_TIMEOUT_MS = 20_000;
const DEFAULT_HOST = "https://api-singapore.klingai.com";

function messageOf(result) {
  return String(result?.json?.message ?? "");
}

function rejectedWithoutTask(result) {
  const data = result?.json?.data;
  return result?.status >= 400 && result?.json?.code !== 0 && !data?.task_id && !data?.taskId;
}

function taskListSnapshot(result) {
  if (result?.status !== 200 || result?.json?.code !== 0) return null;
  if (!result.json?.data || typeof result.json.data !== "object") return null;
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.task_id === "string") ids.add(value.task_id);
    if (typeof value.taskId === "string") ids.add(value.taskId);
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(result.json?.data);
  return [...ids].sort();
}

function sameSnapshot(before, after) {
  return before !== null && after !== null && before.length === after.length &&
    before.every((id, index) => id === after[index]);
}

export function classifySeedValidation(baseline, validSeed, invalidSeed) {
  const base = messageOf(baseline);
  const valid = messageOf(validSeed);
  const invalid = messageOf(invalidSeed);
  if (/unknown|unexpected|not support/i.test(invalid) && /seed/i.test(invalid)) return "unsupported";
  if (/seed/i.test(invalid) && invalid !== base) return "supported";
  if (valid === base && invalid === base) return "inconclusive";
  return "inconclusive";
}

export async function runKlingValidation({
  apiKey = process.env.KLING_API,
  host = process.env.KLING_API_HOST || DEFAULT_HOST,
  fetchImpl = fetch,
  signal = AbortSignal.timeout(KLING_VALIDATION_TIMEOUT_MS),
} = {}) {
  if (!apiKey) return { configured: false };
  const normalizedHost = String(host).replace(/\/$/, "");
  if (!/^https:\/\//.test(normalizedHost)) throw new Error("Kling host is not a secure URL");

  const call = async (path, init = {}) => {
    const response = await fetchImpl(`${normalizedHost}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    return { status: response.status, json };
  };

  const list = await call("/v1/images/generations?pageNum=1&pageSize=20");
  const authenticated = list.status === 200 && list.json?.code === 0;
  if (!authenticated) {
    return { configured: true, authenticated: false, noTaskCreated: true };
  }

  const reference = (await sharp({
    create: { width: 512, height: 512, channels: 3, background: "#c82828" },
  }).png().toBuffer()).toString("base64");

  const cases = [];
  for (const model of KLING_MODELS) {
    for (const resolution of ["1k", "2k"]) {
      for (const mode of ["t2i", "i2i"]) {
        cases.push({ model: model.modelName, resolution, mode });
      }
    }
  }
  const invalid = (body) => call("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ prompt: "validation-only", n: 99, ...body }),
  });
  const [matrixResults, baseline, validSeed, invalidSeed] = await Promise.all([
    Promise.all(cases.map(async (entry) => ({
      ...entry,
      result: await invalid({
        model_name: entry.model,
        resolution: entry.resolution,
        aspect_ratio: "1:1",
        ...(entry.mode === "i2i" ? { image: reference } : {}),
      }),
    }))),
    invalid({ model_name: KLING_MODELS[0].modelName }),
    invalid({ model_name: KLING_MODELS[0].modelName, seed: 12345 }),
    invalid({ model_name: KLING_MODELS[0].modelName, seed: "not-a-number" }),
  ]);

  const matrix = Object.fromEntries(matrixResults.map(({ model, resolution, mode, result }) => [
    `${model}:${resolution}:${mode}`,
    {
      resolutionRejected: /resolution/i.test(messageOf(result)),
      modelRejected: /model/i.test(messageOf(result)),
      validationReachedN: /\bn\b/i.test(messageOf(result)),
      rejectedWithoutTask: rejectedWithoutTask(result),
    },
  ]));
  const afterList = await call("/v1/images/generations?pageNum=1&pageSize=20");
  const requestSafetyPass = [
    ...matrixResults.map((entry) => entry.result), baseline, validSeed, invalidSeed,
  ].every(rejectedWithoutTask);
  const taskListStable = sameSnapshot(taskListSnapshot(list), taskListSnapshot(afterList));
  const noTaskCreated = requestSafetyPass && taskListStable;

  return {
    configured: true,
    authenticated: true,
    requestSafetyPass,
    taskListStable,
    noTaskCreated,
    matrix,
    seedVerdict: classifySeedValidation(baseline, validSeed, invalidSeed),
  };
}

export function expectedKlingRoutingPass(matrix = {}) {
  return KLING_MODELS.every(({ modelName }) => ["t2i", "i2i"].every((mode) => {
    const entry = matrix[`${modelName}:1k:${mode}`];
    return entry && !entry.modelRejected && !entry.resolutionRejected &&
      entry.validationReachedN && entry.rejectedWithoutTask;
  }));
}

export function summarizeKlingMatrix(matrix = {}) {
  let routingPassed = 0;
  let routingTotal = 0;
  let resolutionPassed = 0;
  let resolutionTotal = 0;
  for (const { modelName } of KLING_MODELS) {
    const routingEntries = ["t2i", "i2i"].map((mode) => matrix[`${modelName}:1k:${mode}`]);
    routingTotal++;
    if (routingEntries.every((entry) => entry && !entry.modelRejected &&
      !entry.resolutionRejected && entry.validationReachedN && entry.rejectedWithoutTask)) {
      routingPassed++;
    }
    for (const resolution of ["1k", "2k"]) for (const mode of ["t2i", "i2i"]) {
      resolutionTotal++;
      const entry = matrix[`${modelName}:${resolution}:${mode}`];
      const shouldRejectResolution = modelName === "kling-v2-1" && resolution === "2k" && mode === "i2i";
      const passed = shouldRejectResolution
        ? entry?.resolutionRejected === true && entry?.rejectedWithoutTask === true
        : entry && !entry.resolutionRejected && !entry.modelRejected &&
          entry.validationReachedN && entry.rejectedWithoutTask;
      if (passed) resolutionPassed++;
    }
  }
  return { routingPassed, routingTotal, resolutionPassed, resolutionTotal };
}

export function expectedKlingResolutionPass(matrix = {}) {
  const accepted = [
    "kling-v3:1k:t2i", "kling-v3:1k:i2i", "kling-v3:2k:t2i", "kling-v3:2k:i2i",
    "kling-v2-1:1k:t2i", "kling-v2-1:1k:i2i", "kling-v2-1:2k:t2i",
  ];
  return accepted.every((key) => matrix[key] && !matrix[key].resolutionRejected &&
    !matrix[key].modelRejected && matrix[key].validationReachedN && matrix[key].rejectedWithoutTask) &&
    matrix["kling-v2-1:2k:i2i"]?.resolutionRejected === true &&
    matrix["kling-v2-1:2k:i2i"]?.rejectedWithoutTask === true;
}

export function expectedKlingMatrixPass(matrix = {}) {
  return expectedKlingRoutingPass(matrix) && expectedKlingResolutionPass(matrix);
}
