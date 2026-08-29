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

  const list = await call("/v1/images/generations?pageNum=1&pageSize=1");
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
  const afterList = await call("/v1/images/generations?pageNum=1&pageSize=1");
  const noTaskCreated = afterList.status === 200 && afterList.json?.code === 0 && [
    ...matrixResults.map((entry) => entry.result), baseline, validSeed, invalidSeed,
  ].every(rejectedWithoutTask);

  return {
    configured: true,
    authenticated: true,
    noTaskCreated,
    matrix,
    seedVerdict: classifySeedValidation(baseline, validSeed, invalidSeed),
  };
}

export function expectedKlingMatrixPass(matrix = {}) {
  const accepted = [
    "kling-v3:1k:t2i", "kling-v3:1k:i2i", "kling-v3:2k:t2i", "kling-v3:2k:i2i",
    "kling-v2-1:1k:t2i", "kling-v2-1:1k:i2i", "kling-v2-1:2k:t2i",
  ];
  return accepted.every((key) => matrix[key] && !matrix[key].resolutionRejected &&
    !matrix[key].modelRejected && matrix[key].validationReachedN && matrix[key].rejectedWithoutTask) &&
    matrix["kling-v2-1:2k:i2i"]?.resolutionRejected === true &&
    matrix["kling-v2-1:2k:i2i"]?.rejectedWithoutTask === true;
}
