import { NextRequest, NextResponse } from "next/server";
import {
  getVideoTask,
  isModerationMessage,
  MODERATION_MESSAGE,
} from "@/lib/providers/seedance";
import { isHiggsfieldModel, mcpJobStatus } from "@/lib/providers/higgsfield-mcp";
import { saveFromUrl } from "@/lib/save-media";
import { getItem, upsertItem } from "@/lib/store-db";
import { isMock } from "@/lib/mock";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  const item = await getItem(id);
  if (!item) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (item.status === "succeeded" || item.status === "failed") {
    return NextResponse.json(item);
  }
  if (!item.taskId) {
    return NextResponse.json(item);
  }

  // Safety net: no provider takes this long — fail instead of spinning forever
  // (e.g. when the stored task id turns out not to be a real job).
  const POLL_TIMEOUT_MS = 30 * 60 * 1000;
  if (!isMock() && Date.now() - item.createdAt > POLL_TIMEOUT_MS) {
    const failed = {
      ...item,
      status: "failed" as const,
      error: "Generation timed out — the provider never returned a result.",
      updatedAt: Date.now(),
    };
    await upsertItem(failed);
    return NextResponse.json(failed);
  }

  try {
    if (isMock()) {
      // Pretend it finishes ~6s after creation; "video" reuses the poster image.
      if (Date.now() - item.createdAt > 6000) {
        const done = {
          ...item,
          status: "succeeded" as const,
          url: item.poster,
          updatedAt: Date.now(),
        };
        await upsertItem(done);
        return NextResponse.json(done);
      }
      return NextResponse.json(item);
    }

    // Higgsfield → MCP (returns `url`); native BytePlus Seedance → `videoUrl`.
    const result = isHiggsfieldModel(item.model)
      ? await mcpJobStatus(item.taskId)
      : await getVideoTask(item.taskId);
    const videoUrl =
      (result as { url?: string }).url ?? (result as { videoUrl?: string }).videoUrl;
    if (result.status === "succeeded" && videoUrl) {
      // Download to local storage so it survives provider URL expiry.
      let localUrl = videoUrl;
      try {
        localUrl = await saveFromUrl(videoUrl, "mp4", item.id);
      } catch {
        // fall back to the remote url if download fails
      }
      const done = {
        ...item,
        status: "succeeded" as const,
        url: localUrl,
        updatedAt: Date.now(),
      };
      await upsertItem(done);
      return NextResponse.json(done);
    }
    if (result.status === "failed") {
      const blocked = isModerationMessage(result.error || "");
      const failed = {
        ...item,
        status: "failed" as const,
        error: blocked ? MODERATION_MESSAGE : result.error || "Generation failed.",
        moderationBlocked: blocked,
        updatedAt: Date.now(),
      };
      await upsertItem(failed);
      return NextResponse.json(failed);
    }
    // still running/queued
    const updated = { ...item, status: result.status, updatedAt: Date.now() };
    await upsertItem(updated);
    return NextResponse.json(updated);
  } catch (e: any) {
    console.error("[video status poll error]:", e);
    // Transient poll error — keep the item running in the DB, but surface the error message
    // so the frontend can potentially show a warning. 
    // For debugging, we temporarily mark it as failed in the response (not DB) so the user can see it!
    return NextResponse.json({ ...item, status: "failed", error: `Poll Error: ${e?.message || String(e)}` });
  }
}
