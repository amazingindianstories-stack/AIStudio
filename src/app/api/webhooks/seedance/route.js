import { NextResponse } from "next/server";
import { getItemByTaskId, markCallbackReceived } from "@/lib/store-db";
import { advanceVideoStatus } from "@/lib/video-status-advancement";
import { callbackTokenMatches, extractProviderTaskId } from "@/lib/seedance-callback";
import { getVideoTask, normalizeVideoTaskPayload } from "@/lib/providers/seedance";

export const runtime = "nodejs";
export const maxDuration = 120;

function providerMetadata(payload) {
  const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const normalize = (value) => {
    if (value == null) return undefined;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    providerCreatedAt: normalize(source?.created_at ?? source?.createdAt),
    providerUpdatedAt: normalize(source?.updated_at ?? source?.updatedAt),
    providerStatus: source?.status ?? source?.state,
  };
}

export function createSeedanceCallbackHandler(dependencies = {}) {
  const deps = {
    getItemByTaskId,
    markCallbackReceived,
    advanceVideoStatus,
    getVideoTask,
    now: () => Date.now(),
    ...dependencies,
  };
  return async function handleSeedanceCallback(request) {
  const expected = process.env.SEEDANCE_CALLBACK_SECRET;
  if (!expected) return NextResponse.json({ error: "CALLBACK_NOT_CONFIGURED" }, { status: 503 });
  const supplied = request.nextUrl.searchParams.get("token");
  if (!callbackTokenMatches(supplied, expected)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const taskId = extractProviderTaskId(payload);
  if (!taskId) return NextResponse.json({ error: "INVALID_TASK_ID" }, { status: 400 });

  const item = await deps.getItemByTaskId(taskId);
  if (!item) return NextResponse.json({ accepted: false }, { status: 202 });

  const receivedAt = deps.now();
  const provider = providerMetadata(payload);
  const persisted = await deps.markCallbackReceived(taskId, receivedAt, provider);
  const current = persisted ?? item;
  if (["succeeded", "failed"].includes(current.status)) {
    return NextResponse.json({ accepted: true, outcome: current.status }, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const outcome = await deps.advanceVideoStatus(current, {
    source: "callback",
    callbackReceivedAt: receivedAt,
    provider,
    dependencies: {
      getVideoTask: async (requestedTaskId, options) => requestedTaskId === taskId
        ? normalizeVideoTaskPayload(payload)
        : deps.getVideoTask(requestedTaskId, options),
    },
  });
  return NextResponse.json({ accepted: true, outcome: outcome.kind }, {
    headers: { "Cache-Control": "no-store" },
  });
  };
}

export const POST = createSeedanceCallbackHandler();
