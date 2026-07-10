import { NextRequest, NextResponse } from "next/server";
import {
  ensureDefaultProject,
  createProject,
  renameProject,
  setBrief,
  deleteProject,
  createFolder,
  renameFolder,
  deleteFolder,
} from "@/lib/projects-db";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function GET() {
  // Atomically ensure a default project exists so the UI always has a home.
  const projects = await ensureDefaultProject();
  return NextResponse.json({ projects });
}

/**
 * Single mutation endpoint, switched on `op`. Always returns the full updated
 * project list so the client can resync.
 */
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const op: string = b.op;

  switch (op) {
    case "createProject": {
      const name = (b.name || "").trim();
      if (!name)
        return NextResponse.json({ error: "Name required." }, { status: 400 });
      const user = await getSession();
      const { projects, project } = await createProject(name, user?.id);
      return NextResponse.json({ projects, project });
    }
    case "renameProject":
      return NextResponse.json({
        projects: await renameProject(b.projectId, (b.name || "").trim()),
      });
    case "setBrief":
      return NextResponse.json({
        projects: await setBrief(b.projectId, b.brief ?? ""),
      });
    case "deleteProject": {
      const user = await getSession();
      await logActivity(user?.id ?? null, "delete_project", {
        projectId: b.projectId,
      });
      return NextResponse.json({ projects: await deleteProject(b.projectId) });
    }
    case "createFolder": {
      const name = (b.name || "").trim();
      if (!name)
        return NextResponse.json({ error: "Name required." }, { status: 400 });
      const { projects, folder } = await createFolder(b.projectId, name);
      return NextResponse.json({ projects, folder });
    }
    case "renameFolder":
      return NextResponse.json({
        projects: await renameFolder(b.projectId, b.folderId, (b.name || "").trim()),
      });
    case "deleteFolder": {
      const user = await getSession();
      await logActivity(user?.id ?? null, "delete_folder", {
        projectId: b.projectId,
        folderId: b.folderId,
      });
      return NextResponse.json({
        projects: await deleteFolder(b.projectId, b.folderId),
      });
    }
    default:
      return NextResponse.json({ error: "Unknown op." }, { status: 400 });
  }
}
