import { NextRequest } from "next/server";
import { handleAgentRequest } from "@/lib/agents/route-handler";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return handleAgentRequest("story", req);
}
